import { createSign } from "node:crypto";
import type { CsvFile, CsvFolder } from "./types";

/** The fields Nitya uses from a Google Cloud service account's JSON key file. */
export interface ServiceAccountKey {
  client_email: string;
  private_key: string;
  token_uri?: string;
}

type Fetch = typeof fetch;

const SCOPE = "https://www.googleapis.com/auth/drive.readonly";
const TOKEN_URI = "https://oauth2.googleapis.com/token";
const FILES = "https://www.googleapis.com/drive/v3/files";
const SHEET = "application/vnd.google-apps.spreadsheet";

const base64url = (data: string | Buffer) => Buffer.from(data).toString("base64url");

/** The signed request a service account sends Google for an access token (RS256 JWT, valid for an hour). */
export function serviceAccountJwt(key: ServiceAccountKey, now = Date.now()): string {
  const iat = Math.floor(now / 1000);
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = base64url(JSON.stringify({ iss: key.client_email, scope: SCOPE, aud: key.token_uri ?? TOKEN_URI, iat, exp: iat + 3600 }));
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${claims}`);
  return `${header}.${claims}.${base64url(signer.sign(key.private_key))}`;
}

async function accessToken(key: ServiceAccountKey, fetchFn: Fetch): Promise<string> {
  const res = await fetchFn(key.token_uri ?? TOKEN_URI, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: serviceAccountJwt(key) }),
  });
  if (!res.ok) throw new Error(`Google refused the service account's sign-in (${res.status}): ${await res.text()}`);
  return ((await res.json()) as { access_token: string }).access_token;
}

/** Takes a folder id, or a folder link copied from Drive, and returns the id. */
export function folderIdFrom(linkOrId: string): string {
  const id = /\/folders\/([\w-]+)/.exec(linkOrId)?.[1] ?? linkOrId.trim();
  if (!/^[\w-]+$/.test(id)) throw new Error(`"${linkOrId}" is not a Drive folder link or id.`);
  return id;
}

/**
 * The admin's Drive folder of question CSVs. Plain CSV files are downloaded;
 * Google Sheets are exported as CSV (Drive exports a sheet's first tab).
 * The folder must be shared with the service account's email address.
 */
export function driveFolder(opts: { folder: string; key: ServiceAccountKey; fetch?: Fetch }): CsvFolder {
  const fetchFn = opts.fetch ?? fetch;
  const folderId = folderIdFrom(opts.folder);
  return {
    async files(): Promise<CsvFile[]> {
      const token = await accessToken(opts.key, fetchFn);
      const get = async (url: URL) => {
        const res = await fetchFn(url, { headers: { authorization: `Bearer ${token}` } });
        if (!res.ok) throw new Error(`Drive said ${res.status} for ${url.pathname}: ${await res.text()}`);
        return res;
      };
      const found: { id: string; name: string; mimeType: string }[] = [];
      let pageToken: string | undefined;
      do {
        const url = new URL(FILES);
        url.search = new URLSearchParams({
          q: `'${folderId}' in parents and trashed = false`,
          fields: "nextPageToken, files(id, name, mimeType)",
          orderBy: "name",
          pageSize: "100",
          supportsAllDrives: "true",
          includeItemsFromAllDrives: "true",
          ...(pageToken ? { pageToken } : {}),
        }).toString();
        const page = (await (await get(url)).json()) as { nextPageToken?: string; files: typeof found };
        found.push(...page.files);
        pageToken = page.nextPageToken;
      } while (pageToken);

      return found
        .filter(f => f.mimeType === SHEET || f.mimeType === "text/csv" || f.name.toLowerCase().endsWith(".csv"))
        .map(f => ({
          id: f.id,
          name: f.name,
          async text() {
            const url = f.mimeType === SHEET ? new URL(`${FILES}/${f.id}/export`) : new URL(`${FILES}/${f.id}`);
            url.search = (f.mimeType === SHEET
              ? new URLSearchParams({ mimeType: "text/csv" })
              : new URLSearchParams({ alt: "media", supportsAllDrives: "true" })).toString();
            return (await get(url)).text();
          },
        }));
    },
  };
}
