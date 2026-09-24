// A Piper voice, made ready for sherpa-onnx — without downloading it again.
//
// sherpa-onnx runs the very same Piper model, and needs two things the Piper
// download does not include: seven metadata entries inside the .onnx (what kind
// of model, its espeak voice, its sample rate…) and a tokens.txt listing the
// phoneme ids. Both come straight from the voice's own .onnx.json. Checked
// against sherpa's own packaging of en_US-ryan-high: their .onnx is the original
// byte for byte with those entries appended, and their tokens.txt is the
// json's phoneme_id_map. So this makes the identical file, locally, for every
// voice in voices/ — including ones added later.
//
// The converted copy goes in cache/sherpa-voices/, never over the original,
// which the Python Piper (and the voice list) still read.

import fs from "node:fs";
import path from "node:path";

/** The metadata sherpa-onnx reads, from a Piper .onnx.json, in sherpa's order. */
export function sherpaMetadata(json) {
  return [
    ["model_type", "vits"],
    ["comment", "piper"],
    ["language", String(json.language?.name_english ?? "English")],
    ["voice", String(json.espeak?.voice ?? "en-us")],
    ["has_espeak", "1"],
    ["n_speakers", String(json.num_speakers ?? 1)],
    ["sample_rate", String(json.audio?.sample_rate ?? 22050)],
  ];
}

function varint(n) {
  const out = [];
  while (n > 127) {
    out.push((n & 0x7f) | 0x80);
    n >>>= 7;
  }
  out.push(n);
  return Buffer.from(out);
}
const field = (no, bytes) => Buffer.concat([varint((no << 3) | 2), varint(bytes.length), bytes]);

/**
 * The bytes to append to a model: one ModelProto metadata_props entry (field
 * 14, a StringStringEntryProto of key = 1, value = 2) per pair. Protobuf lets a
 * repeated field appear at the end of a message, so appending is enough.
 */
export function metadataBytes(pairs) {
  return Buffer.concat(pairs.map(([key, value]) => field(14, Buffer.concat([field(1, Buffer.from(key)), field(2, Buffer.from(value))]))));
}

/** tokens.txt: "<phoneme> <id>" per line, from the json's phoneme_id_map. */
export function tokensText(json) {
  return (
    Object.entries(json.phoneme_id_map ?? {})
      .map(([token, ids]) => `${token} ${ids[0]}`)
      .join("\n") + "\n"
  );
}

/**
 * Make (or reuse) the sherpa-ready copy of a Piper voice.
 * @param {string} onnxPath  voices/<name>.onnx, with <name>.onnx.json beside it
 * @param {string} cacheDir  where converted voices are kept
 * @returns {{ model: string, tokens: string, sampleRate: number, noiseScale: number, noiseScaleW: number, lengthScale: number }}
 */
export function sherpaVoice(onnxPath, cacheDir) {
  const json = JSON.parse(fs.readFileSync(`${onnxPath}.json`, "utf8"));
  const name = path.basename(onnxPath, ".onnx");
  const dir = path.join(cacheDir, name);
  const model = path.join(dir, `${name}.onnx`);
  const tokens = path.join(dir, "tokens.txt");
  const extra = metadataBytes(sherpaMetadata(json));
  const expected = fs.statSync(onnxPath).size + extra.length;

  // Remade when the original changed size, or a half-written copy was left behind.
  if (!fs.existsSync(model) || fs.statSync(model).size !== expected || !fs.existsSync(tokens)) {
    fs.mkdirSync(dir, { recursive: true });
    const temp = `${model}.tmp`;
    fs.copyFileSync(onnxPath, temp);
    fs.appendFileSync(temp, extra);
    fs.renameSync(temp, model);
    fs.writeFileSync(tokens, tokensText(json), "utf8");
  }

  const inference = json.inference ?? {};
  return {
    model,
    tokens,
    sampleRate: Number(json.audio?.sample_rate ?? 22050),
    noiseScale: Number(inference.noise_scale ?? 0.667),
    noiseScaleW: Number(inference.noise_w ?? 0.8),
    lengthScale: Number(inference.length_scale ?? 1),
  };
}
