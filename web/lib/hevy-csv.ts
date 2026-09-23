/**
 * Hevy CSV import: turn the file Hevy exports (Profile → Settings → Export &
 * Import Data → Export Workouts) into the same workout shape the Hevy API
 * returns, so the sync engine cannot tell the two apart.
 *
 * Why a second source at all: the Hevy API needs Hevy Pro. The CSV export does
 * not, so this is the only way a free Hevy account can sync to Garmin, and it is
 * also a way to backfill history without an API key.
 *
 * The export has one row per SET, not per workout:
 *
 *   title, start_time, end_time, description, exercise_title, superset_id,
 *   exercise_notes, set_index, set_type, weight_kg | weight_lbs, reps,
 *   distance_km | distance_miles, duration_seconds, rpe
 *
 * Two things in it need care:
 *
 *   - Times are local wall-clock ("15 Jan 2024, 18:30") with no offset. They are
 *     converted to UTC with the user's timezone. A wrong zone shifts every
 *     workout, which is why the caller has to supply one.
 *   - There are no Hevy ids. Each workout gets a deterministic id from its local
 *     start time, so importing a newer export that repeats old workouts maps them
 *     onto the same ids, and the ledger's id-based dedup keeps them from being
 *     uploaded twice.
 *
 * Pure: no IO, so every rule here is unit-tested.
 */

/** Prefix of every id this module makes, so an imported workout is recognisable. */
export const CSV_ID_PREFIX = "csv-";

const KG_PER_LB = 0.45359237;
const METERS_PER_MILE = 1609.344;

export interface CsvSet {
  index: number;
  type: string;
  weight_kg: number | null;
  reps: number | null;
  distance_meters: number | null;
  duration_seconds: number | null;
  rpe: number | null;
}

export interface CsvExercise {
  index: number;
  title: string;
  notes: string | null;
  exercise_template_id: null;
  superset_id: number | null;
  sets: CsvSet[];
}

export interface CsvWorkout {
  id: string;
  title: string;
  description: string | null;
  start_time: string;
  end_time: string | null;
  updated_at: null;
  exercises: CsvExercise[];
  /** Marks the workout as imported, for display. The engine ignores it. */
  source: "csv";
  [key: string]: unknown;
}

export class HevyCsvError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "HevyCsvError";
  }
}

/**
 * Split CSV text into rows of fields. Handles quoted fields, doubled quotes
 * inside them, newlines inside them, CRLF line ends and a leading BOM. Blank
 * lines are dropped.
 */
export function parseCsvRows(text: string): string[][] {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;

  const endField = () => {
    row.push(field);
    field = "";
  };
  const endRow = () => {
    endField();
    if (row.length > 1 || row[0] !== "") rows.push(row);
    row = [];
  };

  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        field += c;
      }
      continue;
    }
    if (c === '"') quoted = true;
    else if (c === ",") endField();
    else if (c === "\n") endRow();
    else if (c === "\r") {
      if (src[i + 1] === "\n") i++;
      endRow();
    } else field += c;
  }
  if (quoted) throw new HevyCsvError("The CSV ends inside a quoted field; the file looks truncated.");
  if (field !== "" || row.length) endRow();
  return rows;
}

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

/** A local wall-clock time, as written in the export. */
export interface WallTime {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

/**
 * Read a time from the export. Hevy writes "15 Jan 2024, 18:30"; an ISO-style
 * "2024-01-15 18:30:00" is accepted too. Returns null for anything else.
 */
export function parseWallTime(raw: string): WallTime | null {
  const s = raw.trim();
  let m = s.match(/^(\d{1,2})\s+([A-Za-z]{3})[A-Za-z]*\.?\s+(\d{4}),?\s+(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (m) {
    const month = MONTHS[m[2].toLowerCase()];
    if (!month) return null;
    return check({ year: +m[3], month, day: +m[1], hour: +m[4], minute: +m[5], second: +(m[6] ?? 0) });
  }
  m = s.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (m) {
    return check({ year: +m[1], month: +m[2], day: +m[3], hour: +m[4], minute: +m[5], second: +(m[6] ?? 0) });
  }
  return null;
}

function check(t: WallTime): WallTime | null {
  const ok =
    t.month >= 1 && t.month <= 12 && t.day >= 1 && t.day <= 31 &&
    t.hour <= 23 && t.minute <= 59 && t.second <= 59;
  return ok ? t : null;
}

/** How far `timeZone` is ahead of UTC at the instant `utcMs`, in ms. */
function zoneOffsetMs(utcMs: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
  }).formatToParts(new Date(utcMs));
  const n = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  const asIfUtc = Date.UTC(n("year"), n("month") - 1, n("day"), n("hour"), n("minute"), n("second"));
  return asIfUtc - Math.floor(utcMs / 1000) * 1000;
}

/**
 * The UTC instant at which the clock in `timeZone` reads `t`.
 *
 * The offset depends on the instant, which is what is being solved for, so it
 * is applied twice: the first pass lands within an hour of the answer, the
 * second corrects for a DST change between the guess and the answer. A time
 * that does not exist (skipped by a spring-forward) lands just after the gap.
 */
export function wallTimeToUtc(t: WallTime, timeZone: string): Date {
  const naive = Date.UTC(t.year, t.month - 1, t.day, t.hour, t.minute, t.second);
  let utc = naive - zoneOffsetMs(naive, timeZone);
  utc = naive - zoneOffsetMs(utc, timeZone);
  return new Date(utc);
}

/** ISO 8601 in the form the Hevy API uses: "2026-07-09T06:34:49+00:00". */
function toHevyIso(d: Date): string {
  return d.toISOString().replace(/\.\d{3}Z$/, "+00:00");
}

const pad = (n: number, w = 2) => String(n).padStart(w, "0");

/** The id for a workout that started at local time `t`: "csv-20240115T1830". */
export function csvWorkoutId(t: WallTime): string {
  return `${CSV_ID_PREFIX}${pad(t.year, 4)}${pad(t.month)}${pad(t.day)}T${pad(t.hour)}${pad(t.minute)}`;
}

function num(raw: string | undefined): number | null {
  if (raw == null) return null;
  const s = raw.trim();
  if (!s) return null;
  const v = Number(s);
  return Number.isFinite(v) ? v : null;
}

function text(raw: string | undefined): string | null {
  const s = raw?.trim();
  return s ? s : null;
}

const round = (v: number, places: number) => Math.round(v * 10 ** places) / 10 ** places;

export interface ParseOptions {
  /** IANA zone the export's wall-clock times are in. Required. */
  timeZone: string;
}

export interface ParseResult {
  workouts: CsvWorkout[];
  /** Data rows read, one per set. */
  rows: number;
  /** Rows dropped because their start time could not be read. */
  skippedRows: number;
}

/**
 * Parse a Hevy workout export. Throws HevyCsvError when the file is not one
 * (missing columns) so the user learns that instead of seeing zero workouts.
 * Workouts come back newest first, the order the API uses.
 */
export function parseHevyCsv(csv: string, opts: ParseOptions): ParseResult {
  const rows = parseCsvRows(csv);
  if (!rows.length) throw new HevyCsvError("The file is empty.");

  const header = rows[0].map((h) => h.trim().toLowerCase());
  const col = (name: string) => header.indexOf(name);
  const required = ["title", "start_time", "exercise_title"];
  const missing = required.filter((n) => col(n) < 0);
  if (missing.length) {
    throw new HevyCsvError(
      `This does not look like a Hevy workout export: missing column(s) ${missing.join(", ")}.`,
    );
  }

  const idx = {
    title: col("title"),
    start: col("start_time"),
    end: col("end_time"),
    description: col("description"),
    exercise: col("exercise_title"),
    superset: col("superset_id"),
    notes: col("exercise_notes"),
    setIndex: col("set_index"),
    setType: col("set_type"),
    kg: col("weight_kg"),
    lbs: col("weight_lbs"),
    reps: col("reps"),
    km: col("distance_km"),
    miles: col("distance_miles"),
    duration: col("duration_seconds"),
    rpe: col("rpe"),
  };
  const get = (r: string[], i: number) => (i >= 0 ? r[i] : undefined);

  const byKey = new Map<string, CsvWorkout>();
  const lastSetIndex = new Map<string, number>();
  let skippedRows = 0;

  for (const r of rows.slice(1)) {
    const startRaw = get(r, idx.start) ?? "";
    const startWall = parseWallTime(startRaw);
    if (!startWall) {
      skippedRows++;
      continue;
    }
    const title = text(get(r, idx.title)) ?? "Workout";
    const key = `${startRaw.trim()}\u0000${title}`;

    let w = byKey.get(key);
    if (!w) {
      const endWall = parseWallTime(get(r, idx.end) ?? "");
      w = {
        id: csvWorkoutId(startWall),
        title,
        description: text(get(r, idx.description)),
        start_time: toHevyIso(wallTimeToUtc(startWall, opts.timeZone)),
        end_time: endWall ? toHevyIso(wallTimeToUtc(endWall, opts.timeZone)) : null,
        updated_at: null,
        exercises: [],
        source: "csv",
      };
      byKey.set(key, w);
    }

    const exTitle = text(get(r, idx.exercise));
    if (!exTitle) continue;

    // A new exercise starts when the name changes, or when the set numbering
    // restarts under the same name (the same exercise done twice in a row).
    const setIndex = num(get(r, idx.setIndex));
    const prev = w.exercises[w.exercises.length - 1];
    const prevSet = lastSetIndex.get(key);
    const restart = setIndex != null && prevSet != null && setIndex <= prevSet;
    let ex = prev;
    if (!prev || prev.title !== exTitle || restart) {
      ex = {
        index: w.exercises.length,
        title: exTitle,
        notes: text(get(r, idx.notes)),
        exercise_template_id: null,
        superset_id: num(get(r, idx.superset)),
        sets: [],
      };
      w.exercises.push(ex);
    }
    if (setIndex != null) lastSetIndex.set(key, setIndex);

    const kg = num(get(r, idx.kg));
    const lbs = num(get(r, idx.lbs));
    const km = num(get(r, idx.km));
    const miles = num(get(r, idx.miles));
    const reps = num(get(r, idx.reps));
    ex!.sets.push({
      index: ex!.sets.length,
      type: (text(get(r, idx.setType)) ?? "normal").toLowerCase(),
      weight_kg: kg ?? (lbs != null ? round(lbs * KG_PER_LB, 3) : null),
      reps: reps != null ? Math.round(reps) : null,
      distance_meters: km != null ? round(km * 1000, 1) : miles != null ? round(miles * METERS_PER_MILE, 1) : null,
      duration_seconds: num(get(r, idx.duration)),
      rpe: num(get(r, idx.rpe)),
    });
  }

  // Two different workouts in one local minute would share an id. Vanishingly
  // rare, but a shared id would make the second one look already synced.
  const seen = new Map<string, number>();
  const workouts = [...byKey.values()].sort((a, b) => b.start_time.localeCompare(a.start_time));
  for (const w of [...workouts].reverse()) {
    const n = (seen.get(w.id) ?? 0) + 1;
    seen.set(w.id, n);
    if (n > 1) w.id = `${w.id}-${n}`;
  }

  return { workouts, rows: rows.length - 1, skippedRows };
}

/** Workouts that start within this many ms of each other are the same session. */
const SAME_START_MS = 90_000;

/**
 * Combine API workouts with imported ones.
 *
 * An imported workout that the API also returns is dropped: the CSV only keeps
 * minutes and has no Hevy id, so without this a user with both would get every
 * workout twice under two ids, and the second would upload as a duplicate. The
 * match is on start time, which the two sources agree on to the minute.
 *
 * With nothing imported the API list is returned untouched, order included.
 */
export function mergeWorkouts<T extends { start_time?: unknown }>(
  fromApi: readonly T[],
  imported: readonly T[],
): T[] {
  if (!imported.length) return [...fromApi];
  const apiStarts = fromApi
    .map((w) => Date.parse(String(w.start_time ?? "")))
    .filter((t) => Number.isFinite(t));
  const extra = imported.filter((w) => {
    const t = Date.parse(String(w.start_time ?? ""));
    if (!Number.isFinite(t)) return true;
    return !apiStarts.some((a) => Math.abs(a - t) < SAME_START_MS);
  });
  const startOf = (w: T) => {
    const t = Date.parse(String(w.start_time ?? ""));
    return Number.isFinite(t) ? t : 0;
  };
  return [...fromApi, ...extra].sort((a, b) => startOf(b) - startOf(a));
}
