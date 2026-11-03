import { expect, test } from "vitest";

import {
  checkSamples,
  NO_SAMPLES,
  says,
  withSamples,
} from "@/components/upstream-samples";

// What a new upstream's samples may hold (plan 07): an input that's an
// object of its parameters, a 2xx first and other statuses after, each once,
// and bodies that are JSON. Empty is no sample.
test("checkSamples says what doesn't fit, by field", () => {
  expect(says(checkSamples(NO_SAMPLES, []))).toBe(false);
  const said = checkSamples(
    {
      input: '{ "user_id": "7", "page": 1 }',
      responses: [
        { status: "404", body: "" },
        { status: "201", body: "{" },
        { status: "x", body: "null" },
        { status: "409", body: "" },
        { status: "409", body: "" },
      ],
    },
    ["user_id"],
  );
  expect(said).toEqual({
    input: "No parameter is named page: the URL reads user_id.",
    responses: [
      { status: "The first is its 2xx: 200 to 299." },
      {
        status: "300 to 599: its 2xx is the first.",
        body: 'A body is JSON, such as { "id": "7" }.',
      },
      { status: "A status: three digits." },
      {},
      { status: "Listed already." },
    ],
  });
  // 2xx is 200 to 299, and the rest 300 to 599.
  expect(
    checkSamples(
      {
        input: "",
        responses: [
          { status: "300", body: "" },
          { status: "600", body: "" },
        ],
      },
      [],
    ).responses,
  ).toEqual([
    { status: "The first is its 2xx: 200 to 299." },
    { status: "300 to 599: its 2xx is the first." },
  ]);
  expect(checkSamples({ ...NO_SAMPLES, input: "[1]" }, []).input).toBe(
    'A JSON object, with a value for each parameter, such as { "user_id": "7" }.',
  );
  expect(checkSamples({ ...NO_SAMPLES, input: '{ "a": 1 }' }, []).input).toBe(
    "The URL reads no parameter, so there's none named a.",
  );
});

// What they make of an upstream: each parameter's sample from the input,
// the 2xx sample, its status only when it isn't 200, and an output for
// every other status, with a sample when it has a body.
test("withSamples puts the samples in the upstream", () => {
  const request = {
    method: "GET" as const,
    url: "https://x.example.com/{{ id }}",
  };
  expect(
    withSamples(
      { parameters: [{ name: "id" }, { name: "page" }], request },
      {
        input: '{ "id": "7" }',
        responses: [
          { status: "201", body: '{ "ok": true }' },
          { status: "404", body: "null" },
          { status: "409", body: " " },
        ],
      },
    ),
  ).toEqual({
    parameters: [{ name: "id", sample: "7" }, { name: "page" }],
    request,
    sample: { status: 201, body: { ok: true } },
    outputs: [{ status: 404, sample: { body: null } }, { status: 409 }],
  });
  expect(withSamples({ request }, NO_SAMPLES)).toEqual({ request });
});
