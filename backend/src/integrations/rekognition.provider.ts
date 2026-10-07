import crypto from "node:crypto";
import { env, faceVerificationConfigured } from "../config/env";
import { Errors } from "../utils/apiError";

// Minimal AWS Rekognition client (DetectFaces + CompareFaces). No SDK: the
// JSON-1.1 request is signed with AWS Signature V4 using Node's crypto.

export interface RekognitionFaceDetail {
  Confidence?: number;
  Pose?: { Roll?: number; Yaw?: number; Pitch?: number };
  Quality?: { Brightness?: number; Sharpness?: number };
  Smile?: { Value?: boolean; Confidence?: number };
  EyesOpen?: { Value?: boolean; Confidence?: number };
  Sunglasses?: { Value?: boolean; Confidence?: number };
  FaceOccluded?: { Value?: boolean; Confidence?: number };
}

const sha256Hex = (data: string | Buffer) => crypto.createHash("sha256").update(data).digest("hex");
const hmac = (key: string | Buffer, data: string) => crypto.createHmac("sha256", key).update(data).digest();

export interface SigV4Input {
  method: string;
  host: string;
  path: string;
  query?: string;
  headers: Record<string, string>; // must include host and x-amz-date; lower-case names
  body: string;
  region: string;
  service: string;
  accessKeyId: string;
  secretAccessKey: string;
  amzDate: string; // YYYYMMDDTHHMMSSZ
}

// Exported so it can be unit-tested against AWS's published test vectors.
export function signV4(input: SigV4Input): { authorization: string; signature: string; signedHeaders: string } {
  const dateStamp = input.amzDate.slice(0, 8);
  const names = Object.keys(input.headers).map((h) => h.toLowerCase()).sort();
  const canonicalHeaders = names.map((n) => `${n}:${input.headers[n].trim().replace(/\s+/g, " ")}\n`).join("");
  const signedHeaders = names.join(";");
  const canonicalRequest = [
    input.method,
    input.path,
    input.query ?? "",
    canonicalHeaders,
    signedHeaders,
    sha256Hex(input.body),
  ].join("\n");
  const scope = `${dateStamp}/${input.region}/${input.service}/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", input.amzDate, scope, sha256Hex(canonicalRequest)].join("\n");
  const kDate = hmac(`AWS4${input.secretAccessKey}`, dateStamp);
  const kRegion = hmac(kDate, input.region);
  const kService = hmac(kRegion, input.service);
  const kSigning = hmac(kService, "aws4_request");
  const signature = crypto.createHmac("sha256", kSigning).update(stringToSign).digest("hex");
  const authorization = `AWS4-HMAC-SHA256 Credential=${input.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return { authorization, signature, signedHeaders };
}

async function call<T>(target: "DetectFaces" | "CompareFaces", payload: unknown): Promise<T> {
  if (!faceVerificationConfigured) throw Errors.configurationMissing("Face verification");
  const host = `rekognition.${env.REKOGNITION_REGION}.amazonaws.com`;
  const body = JSON.stringify(payload);
  const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, "");
  const headers: Record<string, string> = {
    "content-type": "application/x-amz-json-1.1",
    host,
    "x-amz-date": amzDate,
    "x-amz-target": `RekognitionService.${target}`,
  };
  const { authorization } = signV4({
    method: "POST",
    host,
    path: "/",
    headers,
    body,
    region: env.REKOGNITION_REGION,
    service: "rekognition",
    accessKeyId: env.REKOGNITION_ACCESS_KEY_ID,
    secretAccessKey: env.REKOGNITION_SECRET_ACCESS_KEY,
    amzDate,
  });

  const res = await fetch(`https://${host}/`, {
    method: "POST",
    headers: { ...headers, Authorization: authorization },
    body,
  });
  const json = (await res.json().catch(() => ({}))) as { message?: string; Message?: string; __type?: string };
  if (!res.ok) {
    throw new Error(`Rekognition ${target} failed (HTTP ${res.status}): ${json.message ?? json.Message ?? json.__type ?? "unknown"}`);
  }
  return json as T;
}

export async function detectFaces(image: Buffer): Promise<RekognitionFaceDetail[]> {
  const out = await call<{ FaceDetails?: RekognitionFaceDetail[] }>("DetectFaces", {
    Image: { Bytes: image.toString("base64") },
    Attributes: ["ALL"],
  });
  return out.FaceDetails ?? [];
}

// Best similarity (0-100) between the largest face in `source` and any face
// in `target`; 0 when nothing matches or no face is found.
export async function compareFaces(source: Buffer, target: Buffer, similarityThreshold = 50): Promise<number> {
  try {
    const out = await call<{ FaceMatches?: { Similarity?: number }[] }>("CompareFaces", {
      SourceImage: { Bytes: source.toString("base64") },
      TargetImage: { Bytes: target.toString("base64") },
      SimilarityThreshold: similarityThreshold,
      QualityFilter: "AUTO",
    });
    return Math.max(0, ...(out.FaceMatches ?? []).map((m) => m.Similarity ?? 0));
  } catch (err) {
    // Rekognition returns InvalidParameterException when no face is detectable.
    if (err instanceof Error && /InvalidParameterException|no faces|HTTP 400/i.test(err.message)) return 0;
    throw err;
  }
}
