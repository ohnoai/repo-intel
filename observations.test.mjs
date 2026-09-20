import { describe, expect, it } from "vitest";

import { buildObservations } from "./lib/observations.mjs";

describe("buildObservations", () => {
  it("returns an empty array when there are no entries", () => {
    expect(buildObservations([])).toEqual([]);
  });

  it("passes through a single entry unchanged", () => {
    const entry = {
      id: "diff-base-resolved-to-head",
      message: "Diff base resolved to HEAD; an empty diff is expected.",
    };
    expect(buildObservations([entry])).toEqual([entry]);
  });

  it("de-duplicates entries with the exact same id and message", () => {
    const entry = {
      id: "env-access-not-statically-resolvable",
      message: "An environment variable access could not be resolved statically: api/foo.ts:34.",
    };
    expect(buildObservations([entry, { ...entry }])).toEqual([entry]);
  });

  it("keeps entries that share an id but have different messages", () => {
    const first = {
      id: "env-access-not-statically-resolvable",
      message: "An environment variable access could not be resolved statically: api/bar.ts:12.",
    };
    const second = {
      id: "env-access-not-statically-resolvable",
      message: "An environment variable access could not be resolved statically: api/foo.ts:34.",
    };
    // "bar" sorts before "foo", so this also confirms the message tie-break, not
    // just that both survive de-duplication.
    expect(buildObservations([second, first])).toEqual([first, second]);
  });

  it("keeps entries that share a message but have different ids", () => {
    const first = { id: "id-a", message: "same message" };
    const second = { id: "id-b", message: "same message" };
    expect(buildObservations([first, second])).toEqual([first, second]);
  });

  it("sorts the result by id, then by message, regardless of input order", () => {
    const entries = [
      { id: "zeta", message: "b" },
      { id: "zeta", message: "a" },
      { id: "alpha", message: "z" },
    ];
    expect(buildObservations(entries)).toEqual([
      { id: "alpha", message: "z" },
      { id: "zeta", message: "a" },
      { id: "zeta", message: "b" },
    ]);
  });

  it("drops extra fields, returning plain { id, message } entries", () => {
    const entry = { id: "id-a", message: "text", collector: "configuration", extra: true };
    expect(buildObservations([entry])).toEqual([{ id: "id-a", message: "text" }]);
  });

  it("does not mutate the input array or its entries", () => {
    const entries = [
      { id: "zeta", message: "b" },
      { id: "alpha", message: "a" },
    ];
    const snapshot = entries.map((entry) => ({ ...entry }));

    buildObservations(entries);

    expect(entries).toEqual(snapshot);
  });
});
