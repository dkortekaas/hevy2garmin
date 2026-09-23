import { describe, it, expect } from "vitest";
import {
  csvWorkoutId,
  HevyCsvError,
  mergeWorkouts,
  parseCsvRows,
  parseHevyCsv,
  parseWallTime,
  wallTimeToUtc,
} from "./hevy-csv";

const HEADER =
  '"title","start_time","end_time","description","exercise_title","superset_id","exercise_notes","set_index","set_type","weight_kg","reps","distance_km","duration_seconds","rpe"';

const SAMPLE = [
  HEADER,
  '"Upper","15 Jan 2024, 18:30","15 Jan 2024, 19:35","Felt good","Bench Press (Barbell)",,"",0,"warmup",40,10,,,',
  '"Upper","15 Jan 2024, 18:30","15 Jan 2024, 19:35","Felt good","Bench Press (Barbell)",,"",1,"normal",80,8,,,8.5',
  '"Upper","15 Jan 2024, 18:30","15 Jan 2024, 19:35","Felt good","Lat Pulldown (Cable)",,"slow, controlled",0,"normal",60,12,,,',
  '"Cardio","14 Jan 2024, 07:00","14 Jan 2024, 07:30","","Treadmill",,"",0,"normal",,,3.2,1800,',
].join("\n");

describe("parseCsvRows", () => {
  it("handles quotes, doubled quotes, embedded commas and newlines, CRLF and a BOM", () => {
    const rows = parseCsvRows('﻿a,b\r\n"x, y","he said ""hi""\nthen left"\r\n\r\n1,\n');
    expect(rows).toEqual([
      ["a", "b"],
      ["x, y", 'he said "hi"\nthen left'],
      ["1", ""],
    ]);
  });

  it("refuses a file that ends inside a quote", () => {
    expect(() => parseCsvRows('a,"b')).toThrow(HevyCsvError);
  });
});

describe("parseWallTime", () => {
  it("reads Hevy's format and an ISO-like one", () => {
    expect(parseWallTime("15 Jan 2024, 18:30")).toEqual({ year: 2024, month: 1, day: 15, hour: 18, minute: 30, second: 0 });
    expect(parseWallTime("2024-01-15 18:30:05")).toEqual({ year: 2024, month: 1, day: 15, hour: 18, minute: 30, second: 5 });
  });

  it("rejects what it cannot read", () => {
    expect(parseWallTime("")).toBeNull();
    expect(parseWallTime("15 Foo 2024, 18:30")).toBeNull();
    expect(parseWallTime("15 Jan 2024, 25:30")).toBeNull();
  });
});

describe("wallTimeToUtc", () => {
  it("applies the zone's offset, including DST", () => {
    const t = (s: string) => parseWallTime(s)!;
    expect(wallTimeToUtc(t("15 Jan 2024, 18:30"), "Europe/Amsterdam").toISOString()).toBe("2024-01-15T17:30:00.000Z");
    expect(wallTimeToUtc(t("15 Jul 2024, 18:30"), "Europe/Amsterdam").toISOString()).toBe("2024-07-15T16:30:00.000Z");
    expect(wallTimeToUtc(t("15 Jul 2024, 18:30"), "America/New_York").toISOString()).toBe("2024-07-15T22:30:00.000Z");
    expect(wallTimeToUtc(t("15 Jul 2024, 18:30"), "UTC").toISOString()).toBe("2024-07-15T18:30:00.000Z");
  });

  it("is right just after a DST change", () => {
    // Europe switched to summer time at 02:00 local on 31 March 2024.
    const t = parseWallTime("31 Mar 2024, 03:30")!;
    expect(wallTimeToUtc(t, "Europe/Amsterdam").toISOString()).toBe("2024-03-31T01:30:00.000Z");
  });
});

describe("parseHevyCsv", () => {
  const { workouts, rows, skippedRows } = parseHevyCsv(SAMPLE, { timeZone: "Europe/Amsterdam" });

  it("groups set rows into workouts, newest first, with deterministic ids", () => {
    expect(rows).toBe(4);
    expect(skippedRows).toBe(0);
    expect(workouts.map((w) => w.id)).toEqual(["csv-20240115T1830", "csv-20240114T0700"]);
    expect(workouts[0].start_time).toBe("2024-01-15T17:30:00+00:00");
    expect(workouts[0].end_time).toBe("2024-01-15T18:35:00+00:00");
    expect(workouts[0].title).toBe("Upper");
    expect(workouts[0].description).toBe("Felt good");
    expect(workouts[1].description).toBeNull();
  });

  it("builds exercises and sets in the API's shape", () => {
    const upper = workouts[0];
    expect(upper.exercises.map((e) => e.title)).toEqual(["Bench Press (Barbell)", "Lat Pulldown (Cable)"]);
    expect(upper.exercises[0].sets).toEqual([
      { index: 0, type: "warmup", weight_kg: 40, reps: 10, distance_meters: null, duration_seconds: null, rpe: null },
      { index: 1, type: "normal", weight_kg: 80, reps: 8, distance_meters: null, duration_seconds: null, rpe: 8.5 },
    ]);
    expect(upper.exercises[1].notes).toBe("slow, controlled");
    const cardio = workouts[1].exercises[0].sets[0];
    expect(cardio.distance_meters).toBe(3200);
    expect(cardio.duration_seconds).toBe(1800);
  });

  it("gives the same ids for a later export that repeats a workout", () => {
    const later = [SAMPLE, '"Legs","20 Jan 2024, 18:00","20 Jan 2024, 19:00","","Squat (Barbell)",,"",0,"normal",100,5,,,'].join("\n");
    const ids = parseHevyCsv(later, { timeZone: "Europe/Amsterdam" }).workouts.map((w) => w.id);
    expect(ids).toEqual(["csv-20240120T1800", "csv-20240115T1830", "csv-20240114T0700"]);
  });

  it("converts imperial columns", () => {
    const csv = [
      '"title","start_time","end_time","exercise_title","set_index","set_type","weight_lbs","reps","distance_miles"',
      '"A","1 Feb 2024, 10:00","1 Feb 2024, 11:00","Curl",0,"normal",100,10,',
      '"A","1 Feb 2024, 10:00","1 Feb 2024, 11:00","Run",0,"normal",,,1',
    ].join("\n");
    const [w] = parseHevyCsv(csv, { timeZone: "UTC" }).workouts;
    expect(w.exercises[0].sets[0].weight_kg).toBe(45.359);
    expect(w.exercises[1].sets[0].distance_meters).toBe(1609.3);
  });

  it("splits the same exercise done twice in a row when set numbering restarts", () => {
    const csv = [
      '"title","start_time","exercise_title","set_index","reps"',
      '"A","1 Feb 2024, 10:00","Plank",0,1',
      '"A","1 Feb 2024, 10:00","Plank",1,1',
      '"A","1 Feb 2024, 10:00","Plank",0,1',
    ].join("\n");
    const [w] = parseHevyCsv(csv, { timeZone: "UTC" }).workouts;
    expect(w.exercises.map((e) => e.sets.length)).toEqual([2, 1]);
  });

  it("counts rows whose start time is unreadable instead of guessing", () => {
    const csv = ['"title","start_time","exercise_title"', '"A","someday","Curl"', '"B","1 Feb 2024, 10:00","Curl"'].join("\n");
    const r = parseHevyCsv(csv, { timeZone: "UTC" });
    expect(r.skippedRows).toBe(1);
    expect(r.workouts).toHaveLength(1);
  });

  it("refuses a file that is not a Hevy export", () => {
    expect(() => parseHevyCsv("name,date\nfoo,bar", { timeZone: "UTC" })).toThrow(/missing column/);
    expect(() => parseHevyCsv("", { timeZone: "UTC" })).toThrow(HevyCsvError);
  });

  it("keeps two workouts in the same minute apart", () => {
    const csv = [
      '"title","start_time","exercise_title"',
      '"A","1 Feb 2024, 10:00","Curl"',
      '"B","1 Feb 2024, 10:00","Row"',
    ].join("\n");
    const ids = parseHevyCsv(csv, { timeZone: "UTC" }).workouts.map((w) => w.id).sort();
    expect(ids).toEqual(["csv-20240201T1000", "csv-20240201T1000-2"]);
  });
});

describe("csvWorkoutId", () => {
  it("is built from the local start time", () => {
    expect(csvWorkoutId({ year: 2024, month: 3, day: 5, hour: 7, minute: 9, second: 59 })).toBe("csv-20240305T0709");
  });
});

describe("mergeWorkouts", () => {
  const api = [
    { id: "a2", start_time: "2024-01-15T17:30:41+00:00" },
    { id: "a1", start_time: "2024-01-10T17:30:00+00:00" },
  ];

  it("returns the API list untouched when nothing is imported", () => {
    expect(mergeWorkouts(api, [])).toEqual(api);
  });

  it("drops imported workouts the API also has, and sorts the rest in newest first", () => {
    const imported = [
      { id: "csv-20240120T1800", start_time: "2024-01-20T17:00:00+00:00" },
      { id: "csv-20240115T1830", start_time: "2024-01-15T17:30:00+00:00" }, // same session as a2
      { id: "csv-20240101T1000", start_time: "2024-01-01T09:00:00+00:00" },
    ];
    expect(mergeWorkouts(api, imported).map((w) => w.id)).toEqual(["csv-20240120T1800", "a2", "a1", "csv-20240101T1000"]);
  });
});
