import { createVerify, generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { driveFolder, folderIdFrom, serviceAccountJwt } from "../src/supply/drive";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const KEY = { client_email: "nitya-sync@example.iam.gserviceaccount.com", private_key: privateKey.export({ type: "pkcs8", format: "pem" }).toString() };
const FOLDER = "1AbC_dEf-123";

const decode = (part: string) => JSON.parse(Buffer.from(part, "base64url").toString());

/** A fake Google: a token endpoint and a folder with two pages of files. */
function fakeGoogle() {
  const calls: { url: URL; init?: RequestInit }[] = [];
  const files = [
    { id: "f1", name: "addition.csv", mimeType: "text/csv" },
    { id: "f2", name: "notes.pdf", mimeType: "application/pdf" },
    { id: "f3", name: "Counting", mimeType: "application/vnd.google-apps.spreadsheet" },
    { id: "f4", name: "old.CSV", mimeType: "application/vnd.ms-excel" },
  ];
  const fetch = (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(input);
    calls.push({ url, init });
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
    if (url.href === "https://oauth2.googleapis.com/token") return json({ access_token: "token-1", expires_in: 3599 });
    if (init?.headers && (init.headers as Record<string, string>).authorization !== "Bearer token-1") return new Response("no", { status: 401 });
    if (url.pathname === "/drive/v3/files") {
      return url.searchParams.get("pageToken") === "p2" ? json({ files: files.slice(2) }) : json({ nextPageToken: "p2", files: files.slice(0, 2) });
    }
    if (url.pathname === "/drive/v3/files/f1" && url.searchParams.get("alt") === "media") return new Response("csv of f1");
    if (url.pathname === "/drive/v3/files/f4" && url.searchParams.get("alt") === "media") return new Response("csv of f4");
    if (url.pathname === "/drive/v3/files/f3/export" && url.searchParams.get("mimeType") === "text/csv") return new Response("csv of sheet f3");
    return new Response("not found", { status: 404 });
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

describe("the Drive folder", () => {
  it("signs the service account's token request with its key, for read-only Drive access", () => {
    const jwt = serviceAccountJwt(KEY, Date.UTC(2026, 9, 25, 10, 0, 0));
    const [header, claims, signature] = jwt.split(".");
    expect(decode(header)).toEqual({ alg: "RS256", typ: "JWT" });
    expect(decode(claims)).toEqual({
      iss: KEY.client_email, scope: "https://www.googleapis.com/auth/drive.readonly",
      aud: "https://oauth2.googleapis.com/token", iat: 1792922400, exp: 1792926000,
    });
    const verifier = createVerify("RSA-SHA256");
    verifier.update(`${header}.${claims}`);
    expect(verifier.verify(publicKey, Buffer.from(signature, "base64url"))).toBe(true);
  });

  it("lists every page of the folder, keeps CSVs and Google Sheets, and reads each the right way", async () => {
    const google = fakeGoogle();
    const files = await driveFolder({ folder: FOLDER, key: KEY, fetch: google.fetch }).files();
    expect(files.map(f => f.name)).toEqual(["addition.csv", "Counting", "old.CSV"]);
    expect(await Promise.all(files.map(f => f.text()))).toEqual(["csv of f1", "csv of sheet f3", "csv of f4"]);

    const token = google.calls[0];
    expect(token.init?.method).toBe("POST");
    const body = new URLSearchParams(String(token.init?.body));
    expect(body.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:jwt-bearer");
    expect(body.get("assertion")?.split(".")).toHaveLength(3);

    const list = google.calls[1].url.searchParams;
    expect(list.get("q")).toBe(`'${FOLDER}' in parents and trashed = false`);
    expect(list.get("supportsAllDrives")).toBe("true");
    expect(google.calls.filter(c => c.url.pathname === "/drive/v3/files")).toHaveLength(2);
  });

  it("says what Google answered when it refuses", async () => {
    const refusing = (async () => new Response("invalid_grant", { status: 400 })) as unknown as typeof fetch;
    await expect(driveFolder({ folder: FOLDER, key: KEY, fetch: refusing }).files())
      .rejects.toThrow("Google refused the service account's sign-in (400): invalid_grant");

    const google = fakeGoogle();
    const notShared = (async (input: string | URL, init?: RequestInit) =>
      new URL(input).pathname === "/drive/v3/files" ? new Response("File not found", { status: 404 }) : google.fetch(input, init)
    ) as typeof fetch;
    await expect(driveFolder({ folder: FOLDER, key: KEY, fetch: notShared }).files())
      .rejects.toThrow("Drive said 404 for /drive/v3/files: File not found");
  });

  it("takes a folder link copied from Drive, or a bare id", () => {
    expect(folderIdFrom("https://drive.google.com/drive/folders/1AbC_dEf-123?usp=sharing")).toBe(FOLDER);
    expect(folderIdFrom(" 1AbC_dEf-123 ")).toBe(FOLDER);
    expect(() => folderIdFrom("' or 1=1")).toThrow("not a Drive folder link or id");
  });
});
