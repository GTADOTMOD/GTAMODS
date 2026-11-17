import { AccountInfo, Connection, PublicKey } from "@solana/web3.js";
import { ExtensionType, TOKEN_2022_PROGRAM_ID, getExtensionData, getTokenMetadata, unpackMint } from "@solana/spl-token";

export interface TokenMeta {
  name?: string;
  symbol?: string;
  uri?: string;
}

export const METADATA_PROGRAM_ID = new PublicKey("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s");

export function metaplexMetadataPda(mint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("metadata"), METADATA_PROGRAM_ID.toBuffer(), mint.toBuffer()],
    METADATA_PROGRAM_ID,
  )[0];
}

/** Reads name / symbol / uri from a Metaplex metadata account (the layout
 * legacy SPL-token pump.fun coins use): key(1) update_authority(32)
 * mint(32), then three u32-length-prefixed strings padded with NULs. */
export function decodeMetaplexMetadata(data: Buffer): { name: string; symbol: string; uri: string } | null {
  try {
    let offset = 1 + 32 + 32;
    const read = (maxLen: number) => {
      const len = data.readUInt32LE(offset);
      offset += 4;
      if (len > maxLen || offset + len > data.length) throw new Error("bad length");
      const s = data.subarray(offset, offset + len).toString("utf8").replace(/\0+$/g, "").trim();
      offset += len;
      return s;
    };
    const name = read(64);
    const symbol = read(32);
    const uri = read(256);
    return { name, symbol, uri };
  } catch {
    return null;
  }
}

/** Reads name / symbol / uri from a Token-2022 mint's metadata extension (what
 * newer pump.fun coins use): update_authority(32) mint(32), then three
 * u32-length-prefixed strings. */
export function decodeToken2022Metadata(mint: PublicKey, info: AccountInfo<Buffer>): TokenMeta | null {
  try {
    const data = getExtensionData(ExtensionType.TokenMetadata, unpackMint(mint, info, TOKEN_2022_PROGRAM_ID).tlvData);
    if (!data) return null;
    let offset = 32 + 32;
    const read = () => {
      const len = data.readUInt32LE(offset);
      offset += 4;
      const s = data.subarray(offset, offset + len).toString("utf8").replace(/\0+$/g, "").trim();
      offset += len;
      return s;
    };
    return { name: read(), symbol: read(), uri: read() };
  } catch {
    return null;
  }
}

const LOOKUP_BATCH = 50;
const LOOKUP_RETRY_MS = 60_000;

/** Names and symbols for mints from on-chain metadata, cached for the session. */
export class MetaResolver {
  private cache = new Map<string, TokenMeta>();
  private triedAt = new Map<string, number>();
  private queue: string[] = [];
  private draining: Promise<void> | null = null;

  constructor(
    private connection: Connection,
    private now: () => number = Date.now,
  ) {}

  remember(mint: string, meta: TokenMeta): void {
    const prev = this.cache.get(mint) ?? {};
    this.cache.set(mint, { ...prev, ...Object.fromEntries(Object.entries(meta).filter(([, v]) => v)) });
  }

  peek(mint: string): TokenMeta | undefined {
    return this.cache.get(mint);
  }

  async resolve(mint: PublicKey, mintInfo?: AccountInfo<Buffer> | null): Promise<TokenMeta> {
    const key = mint.toBase58();
    const hit = this.cache.get(key);
    if (hit?.symbol) return hit;
    const meta = await this.fromChain(mint, mintInfo);
    this.remember(key, meta);
    return this.cache.get(key) ?? meta;
  }

  /** Looks up unknown names in the background, in batches, so a list can show
   * now and pick the names up on its next refresh. Ones that couldn't be read
   * (rate limits, usually) are tried again later. */
  fill(mints: string[]): Promise<void> {
    for (const m of mints) {
      if (this.cache.get(m)?.symbol) continue;
      const tried = this.triedAt.get(m);
      if (tried !== undefined && this.now() - tried < LOOKUP_RETRY_MS) continue;
      this.triedAt.set(m, this.now());
      this.queue.push(m);
    }
    this.draining ??= this.drain().finally(() => {
      this.draining = null;
    });
    return this.draining;
  }

  private async drain(): Promise<void> {
    while (this.queue.length > 0) {
      const batch = this.queue.splice(0, LOOKUP_BATCH).map((m) => new PublicKey(m));
      try {
        const infos = await this.connection.getMultipleAccountsInfo([...batch, ...batch.map(metaplexMetadataPda)]);
        batch.forEach((mint, i) => {
          const mintInfo = infos[i];
          const meta = mintInfo?.owner.equals(TOKEN_2022_PROGRAM_ID) ? decodeToken2022Metadata(mint, mintInfo) : null;
          const legacy = infos[batch.length + i];
          const found = meta ?? (legacy ? decodeMetaplexMetadata(legacy.data) : null);
          if (found) this.remember(mint.toBase58(), found);
        });
      } catch {
        // Unknown names are fine for now; the list shows addresses and retries.
      }
    }
  }

  private async fromChain(mint: PublicKey, mintInfo?: AccountInfo<Buffer> | null): Promise<TokenMeta> {
    try {
      const info = mintInfo ?? (await this.connection.getAccountInfo(mint));
      if (info?.owner.equals(TOKEN_2022_PROGRAM_ID)) {
        const md = await getTokenMetadata(this.connection, mint, "confirmed", TOKEN_2022_PROGRAM_ID);
        if (md) return { name: md.name, symbol: md.symbol, uri: md.uri };
      }
      const acct = await this.connection.getAccountInfo(metaplexMetadataPda(mint));
      const md = acct ? decodeMetaplexMetadata(acct.data) : null;
      if (md) return { name: md.name, symbol: md.symbol, uri: md.uri };
    } catch {
      // Unknown metadata is fine; the UI shows the address instead.
    }
    return {};
  }
}
