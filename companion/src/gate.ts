import BN from "bn.js";
import bs58 from "bs58";
import qrcode from "qrcode-generator";
import { Connection, Keypair, PublicKey, SystemProgram, TransactionInstruction } from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
  unpackMint,
} from "@solana/spl-token";
import { Config, ConfigError, DEFAULT_CONFIG, validateConfig } from "./config.js";
import { fmtCompact, fmtSol, lamportsToSol, phoneText, rawToUi, shortAddr, ticker } from "./format.js";
import {
  DEFAULT_KDF,
  KdfParams,
  KeystoreFile,
  MIN_PASSWORD_LENGTH,
  WrongPasswordError,
  archiveKeystore,
  decryptKeypair,
  encryptKeypair,
  keystoreExists,
  parseSecretKey,
  readKeystore,
  saveKeystore,
} from "./keystore.js";
import { MetaResolver } from "./metadata.js";
import { PumpEngine } from "./pump.js";
import { BuiltTx, UserError, buildTx, parsePublicKey, sendAndConfirm, simulate } from "./solana.js";
import { History, QuoteStore } from "./store.js";
import { Action, Icon, NAV, PLAIN, PRIMARY, PhoneApp, Row, SELL, Screen, UiHandler, UiResponse, WARN, info, open, post, row, screen, stat, toRawAmount, toast } from "./ui.js";

/*
 * The wallet's front door. The companion starts with no key in memory, and
 * until the player creates or unlocks a wallet on the phone, these screens are
 * all the phone can reach. After that, requests pass through to PhoneApp.
 *
 * Anything that could spend or expose funds beyond the per-trade limits asks
 * for the password again here: real sends, showing the key, real money, raising
 * a limit, changing the RPC, changing the password and resetting the wallet.
 * Any program on the PC can read the API's token, so an unlocked wallet must not
 * be enough to read out its key or empty it.
 */

const MAX_PASSWORD_LENGTH = 64;
const KEY_COPY_TTL_MS = 120_000;
const KEY_LINE_LENGTH = 30;
const SEND_TTL_MS = 120_000;
const SOL = "SOL";
const SOL_DECIMALS = 9;
const SEND_FEE_RESERVE_LAMPORTS = new BN(2_000_000); // left behind so fees can be paid
const NEW_WALLET_MIN_LAMPORTS = new BN(890_880); // Solana's minimum for an account to exist
const SEND_COMPUTE_UNITS = 100_000;
const RESET_WORD = "RESET";

/** The limits a player can change on the phone. Raising one needs the password. */
const LIMITS = {
  slippage: { title: "Slippage", unit: "%", presets: [1, 3, 5, 10, 20, 30], min: 0.1, max: 50, ask: "Slippage in %, 0.1 to 50", about: "How much a price may move on you." },
  max: { title: "Max per trade", unit: " SOL", presets: [0.1, 0.25, 0.5, 1, 2, 5], min: 0.01, max: 100, ask: "Most SOL one trade can spend", about: "The most SOL one trade can spend." },
} as const;
type LimitKind = keyof typeof LIMITS;

interface PendingSend {
  asset: string;
  to: PublicKey;
  raw: BN;
  decimals: number;
  symbol: string;
  program?: PublicKey;
}

export interface WalletStore {
  exists(): boolean;
  read(): KeystoreFile;
  save(file: KeystoreFile): void;
  /** Takes the wallet out of use, without destroying its encrypted file. */
  remove(): void;
}

export const diskWallet: WalletStore = { exists: keystoreExists, read: readKeystore, save: saveKeystore, remove: archiveKeystore };

export interface GateDeps {
  config: Config;
  makeApp: (wallet: Keypair) => PhoneApp;
  saveConfig: (config: Config) => void;
  copy: (text: string) => Promise<void>;
  paste: () => Promise<string>;
  connection: Connection;
  engine: PumpEngine;
  meta: MetaResolver;
  history: History;
  store?: WalletStore;
  /** Overridable for tests. */
  send?: (connection: Connection, built: BuiltTx) => Promise<string>;
  /** Overridable for tests and the simulator. */
  newKeypair?: () => Keypair;
  kdf?: KdfParams;
  log?: (msg: string) => void;
}

const askPassword = (title: string, hint: string, path: string, body?: Record<string, unknown>): Action => ({
  kind: "secret",
  title,
  hint,
  maxLength: MAX_PASSWORD_LENGTH,
  path,
  field: "password",
  body,
});

function passwordIn(b: Record<string, unknown>): string {
  return typeof b.password === "string" ? b.password : "";
}

/** The dark and light squares of a QR code, one string of 0s and 1s per row. */
export function qrModules(text: string): string[] {
  const qr = qrcode(0, "L");
  qr.addData(text);
  qr.make();
  const size = qr.getModuleCount();
  return Array.from({ length: size }, (_, r) =>
    Array.from({ length: size }, (_, c) => (qr.isDark(r, c) ? "1" : "0")).join(""),
  );
}

export class WalletGate implements UiHandler {
  private wallet: Keypair | null = null;
  private app: PhoneApp | null = null;
  private pendingPassword: string | null = null;
  private pendingImport: Keypair | null = null;
  private keyCopies = new QuoteStore<true>(KEY_COPY_TTL_MS);
  private passwordChanges = new QuoteStore<true>(KEY_COPY_TTL_MS);
  private sends = new QuoteStore<PendingSend>(SEND_TTL_MS);
  private store: WalletStore;

  constructor(private d: GateDeps) {
    this.store = d.store ?? diskWallet;
  }

  /** Opens with a wallet already in hand, for the simulator. */
  openWith(wallet: Keypair): this {
    this.wallet = wallet;
    this.app = this.d.makeApp(wallet);
    return this;
  }

  async handle(method: string, url: URL, body: Record<string, unknown>): Promise<UiResponse | null> {
    try {
      return await this.route(method, url, body);
    } catch (e) {
      if (e instanceof UserError) return toast(e.message, "error");
      this.d.log?.(`error on ${method} ${url.pathname}: ${(e as Error).stack ?? String(e)}`);
      return toast(`Error: ${(e as Error).message}`, "error");
    }
  }

  private async route(method: string, url: URL, b: Record<string, unknown>): Promise<UiResponse | null> {
    const path = url.pathname;
    if (method === "POST") {
      switch (path) {
        case "/ui/setup/password": return this.choosePassword(b);
        case "/ui/setup/confirm": return this.confirmPassword(b);
        case "/ui/setup/import": return this.importWallet();
        case "/ui/unlock": return this.unlock(b);
        case "/ui/reset/forgot": return this.resetWithoutPassword(b);
      }
    }
    if (method === "GET" && !this.wallet) {
      if (path === "/ui/setup/import" && !this.store.exists()) return { nav: "push", screen: this.importScreen() };
      if (path === "/ui/reset/forgot" && this.store.exists()) return { nav: "push", screen: this.forgotScreen() };
    }
    if (!this.wallet || !this.app) {
      return method === "POST"
        ? { nav: "home", toast: { text: "Unlock your wallet first.", level: "error" } }
        : { nav: "push", screen: this.lockedScreen() };
    }
    if (method === "GET") {
      switch (path) {
        case "/ui/deposit": return { nav: "push", screen: this.depositScreen(this.wallet) };
        case "/ui/backup": return { nav: "push", screen: this.backupScreen() };
        case "/ui/mode": return { nav: "push", screen: this.modeScreen() };
        case "/ui/send": return { nav: "push", screen: await this.sendScreen(this.wallet) };
        case "/ui/send/to": return { nav: "push", screen: await this.sendToScreen(this.wallet, url.searchParams.get("asset") ?? "") };
        case "/ui/settings": return { nav: "push", screen: this.settingsScreen(this.wallet) };
        case "/ui/settings/slippage": return { nav: "push", screen: this.limitScreen("slippage") };
        case "/ui/settings/max": return { nav: "push", screen: this.limitScreen("max") };
        case "/ui/settings/rpc": return { nav: "push", screen: this.rpcScreen() };
        case "/ui/reset": return { nav: "push", screen: await this.resetScreen(this.wallet) };
      }
    }
    if (method === "POST") {
      switch (path) {
        case "/ui/send/paste": return this.sendAddress(this.wallet, String(b.asset ?? ""), await this.d.paste());
        case "/ui/send/address": return this.sendAddress(this.wallet, String(b.asset ?? ""), String(b.to ?? ""));
        case "/ui/send/review": return this.reviewSend(this.wallet, b);
        case "/ui/send/execute": return this.executeSend(this.wallet, b);
        case "/ui/wallet/copy-address": return this.copyAddress(this.wallet);
        case "/ui/backup/reveal": return this.revealKey(b);
        case "/ui/backup/copy": return this.copyKey(this.wallet, b);
        case "/ui/mode/real": return this.useRealMoney(this.wallet, b);
        case "/ui/mode/practice": return this.setMode(this.wallet, true, "Back in Practice: nothing is sent");
        case "/ui/settings/set": return this.setLimit(this.wallet, b);
        case "/ui/settings/rpc/paste": return this.pasteRpc();
        case "/ui/settings/rpc/set": return this.setRpc(this.wallet, b);
        case "/ui/settings/password/current": return this.checkCurrentPassword(b);
        case "/ui/settings/password/new": return this.chooseNewPassword(b);
        case "/ui/settings/password/repeat": return this.repeatNewPassword(this.wallet, b);
        case "/ui/lock": return this.lock();
        case "/ui/reset/confirm": return this.resetWithPassword(b);
      }
    }
    return this.app.handle(method, url, b);
  }

  // ---- first run and unlocking ----------------------------------------------

  private lockedScreen(): Screen {
    this.pendingPassword = null;
    this.pendingImport = null;
    return this.store.exists() ? this.unlockScreen() : this.welcomeScreen();
  }

  private welcomeScreen(): Screen {
    return screen("/ui/home", "Set up your wallet", [
      info("RUGR trades from its own wallet."),
      info("You fund it yourself with SOL."),
      info("Only add what you can lose.", Icon.None, WARN),
      row("Create wallet", Icon.Profile, askPassword("Choose a password", `At least ${MIN_PASSWORD_LENGTH} characters`, "/ui/setup/password"), PRIMARY),
      row("Import a wallet", Icon.Attachment, open("/ui/setup/import"), { kind: "nav", glyph: "down" }),
    ]);
  }

  private unlockScreen(): Screen {
    return screen("/ui/home", "Unlock wallet", [
      stat("Wallet", shortAddr(this.store.read().address), Icon.Profile),
      row("Enter password", Icon.Lock, askPassword("Enter password", "To unlock your wallet", "/ui/unlock"), PRIMARY),
      row("Forgot password", Icon.Lock, open("/ui/reset/forgot"), NAV),
    ]);
  }

  private importScreen(): Screen {
    return screen("", "Import a wallet", [
      info("Copy your private key from Phantom"),
      info("or another wallet, then Paste."),
      info("It stays on this PC, encrypted."),
      row("Paste private key", Icon.Attachment, post("/ui/setup/import"), { kind: "button", tone: "primary", glyph: "paste" }),
    ]);
  }

  private async importWallet(): Promise<UiResponse> {
    if (this.store.exists()) throw new UserError("A wallet already exists.");
    let wallet: Keypair;
    try {
      wallet = parseSecretKey(await this.d.paste());
    } catch (e) {
      if (e instanceof UserError) throw e;
      throw new UserError("That isn't a private key. Copy it first."); // never says what was on the clipboard
    }
    await this.d.copy("").catch(() => undefined); // a key shouldn't sit on the clipboard
    this.pendingImport = wallet;
    return {
      nav: "replace",
      screen: screen("", "Import a wallet", [
        stat("Wallet", shortAddr(wallet.publicKey.toBase58()), Icon.Profile),
        info("Choose a password to protect it."),
        row("Choose a password", Icon.Lock, askPassword("Choose a password", `At least ${MIN_PASSWORD_LENGTH} characters`, "/ui/setup/password"), PRIMARY),
      ]),
    };
  }

  private choosePassword(b: Record<string, unknown>): UiResponse {
    if (this.store.exists()) throw new UserError("A wallet already exists.");
    const password = passwordIn(b);
    if (password.length < MIN_PASSWORD_LENGTH) throw new UserError(`Use at least ${MIN_PASSWORD_LENGTH} characters.`);
    if (password.length > MAX_PASSWORD_LENGTH) throw new UserError(`Use at most ${MAX_PASSWORD_LENGTH} characters.`);
    this.pendingPassword = password;
    return {
      nav: "push",
      screen: screen("", "Repeat password", [
        info("Type the same password again."),
        info("It can't be reset if you forget it.", Icon.None, WARN),
        row("Repeat password", Icon.Lock, askPassword("Repeat password", "The same one again", "/ui/setup/confirm"), PRIMARY),
      ]),
    };
  }

  private confirmPassword(b: Record<string, unknown>): UiResponse {
    if (this.store.exists()) throw new UserError("A wallet already exists.");
    const password = this.pendingPassword;
    this.pendingPassword = null;
    if (password === null) return { nav: "home", toast: { text: "Start again.", level: "error" } };
    if (passwordIn(b) !== password) return { nav: "back", toast: { text: "Passwords didn't match. Try again.", level: "error" } };

    const imported = this.pendingImport;
    this.pendingImport = null;
    const wallet = imported ?? (this.d.newKeypair ?? Keypair.generate)();
    this.store.save(encryptKeypair(wallet, password, this.d.kdf ?? DEFAULT_KDF));
    this.openWith(wallet);
    if (imported) return { nav: "home", toast: { text: "Wallet imported", level: "success" } };
    return { nav: "replace", screen: this.createdScreen(wallet), toast: { text: "Wallet created", level: "success" } };
  }

  private createdScreen(wallet: Keypair): Screen {
    return screen("", "Wallet created", [
      stat("Address", shortAddr(wallet.publicKey.toBase58()), Icon.Profile),
      row("Receive SOL", Icon.Camera, open("/ui/deposit"), NAV),
      row("Copy address", Icon.Attachment, post("/ui/wallet/copy-address"), NAV),
      row("Export private key", Icon.Lock, open("/ui/backup"), NAV),
      info("Back it up. It can't be recovered.", Icon.None, WARN),
      row("Continue", Icon.Ticked, { kind: "home" }, PRIMARY),
    ]);
  }

  private decrypt(b: Record<string, unknown>): Keypair {
    try {
      return decryptKeypair(this.store.read(), passwordIn(b));
    } catch (e) {
      if (e instanceof WrongPasswordError) throw new UserError("Wrong password.");
      throw e;
    }
  }

  private unlock(b: Record<string, unknown>): UiResponse {
    if (this.wallet) return { nav: "home" };
    if (!this.store.exists()) return { nav: "home" };
    this.openWith(this.decrypt(b));
    return { nav: "home" };
  }

  // ---- funding --------------------------------------------------------------

  private depositScreen(wallet: Keypair): Screen {
    const address = wallet.publicKey.toBase58();
    return screen("", "Receive", [
      { text: shortAddr(address), icon: Icon.None, enabled: false, style: { kind: "qr", modules: qrModules(address) } },
      ...this.addressLines(address),
      row("Copy address", Icon.Attachment, post("/ui/wallet/copy-address"), { kind: "button", tone: "primary", glyph: "paste" }),
    ]);
  }

  private addressLines(address: string): Row[] {
    return (address.match(/.{1,22}/g) ?? []).map((line) => info(line));
  }

  private async copyAddress(wallet: Keypair): Promise<UiResponse> {
    await this.d.copy(wallet.publicKey.toBase58());
    return toast("Address copied", "success");
  }

  // ---- sending --------------------------------------------------------------

  private async sendScreen(wallet: Keypair): Promise<Screen> {
    const me = wallet.publicKey;
    const [lamports, holdings] = await Promise.all([
      this.d.engine.solBalance(me).catch(() => new BN(0)),
      this.d.engine.holdings(me).catch(() => []),
    ]);
    const sol = `${fmtSol(lamportsToSol(lamports))} SOL`;
    const rows: Row[] = [row(`SOL ${sol}`, Icon.Attachment, open(`/ui/send/to?asset=${SOL}`), { kind: "nav", label: "SOL", value: sol })];
    const metas = await Promise.all(holdings.slice(0, 20).map((h) => this.d.meta.resolve(h.mint).catch(() => ({ symbol: undefined }))));
    holdings.slice(0, 20).forEach((h, i) => {
      const m = h.mint.toBase58();
      const symbol = ticker(metas[i].symbol, m);
      const amount = fmtCompact(rawToUi(h.amountRaw, h.decimals));
      rows.push(row(`${symbol} ${amount}`, Icon.Attachment, open(`/ui/send/to?asset=${m}`), { kind: "nav", label: symbol, value: amount }));
    });
    return screen("", "What to send", rows);
  }

  /** What the player can send of this asset: all of a token, or SOL less a little for fees. */
  private async asset(wallet: Keypair, asset: string): Promise<{ symbol: string; decimals: number; available: BN; program?: PublicKey }> {
    if (asset === SOL) {
      const lamports = await this.d.engine.solBalance(wallet.publicKey);
      return { symbol: SOL, decimals: SOL_DECIMALS, available: BN.max(new BN(0), lamports.sub(SEND_FEE_RESERVE_LAMPORTS)) };
    }
    const mint = parsePublicKey(asset);
    const account = mint ? await this.d.connection.getAccountInfo(mint, "confirmed") : null;
    if (!mint || !account || !(account.owner.equals(TOKEN_PROGRAM_ID) || account.owner.equals(TOKEN_2022_PROGRAM_ID))) {
      throw new UserError("That isn't a token you hold.");
    }
    const meta = await this.d.meta.resolve(mint).catch(() => ({ symbol: undefined }));
    return {
      symbol: ticker(meta.symbol, asset),
      decimals: unpackMint(mint, account, account.owner).decimals,
      available: await this.d.engine.tokenBalance(mint, account.owner, wallet.publicKey),
      program: account.owner,
    };
  }

  private async sendToScreen(wallet: Keypair, asset: string): Promise<Screen> {
    const a = await this.asset(wallet, asset);
    return screen("", `Send ${phoneText(a.symbol, 12)}`, [
      stat("You can send", `${fmtCompact(rawToUi(a.available, a.decimals))} ${a.symbol}`),
      info("Copy the wallet address to send to."),
      row("Paste wallet address", Icon.Attachment, post("/ui/send/paste", { asset }), { kind: "button", tone: "primary", glyph: "paste" }),
      row("Type wallet address", Icon.EyeFind, { kind: "input", title: "Wallet address to send to", maxLength: 44, path: "/ui/send/address", field: "to", body: { asset } }, NAV),
    ]);
  }

  private recipient(wallet: Keypair, text: string): PublicKey {
    const to = parsePublicKey(text);
    if (!to) throw new UserError("That isn't a wallet address. Copy one first.");
    if (to.equals(wallet.publicKey)) throw new UserError("That's this wallet's own address.");
    return to;
  }

  private async sendAddress(wallet: Keypair, asset: string, text: string): Promise<UiResponse> {
    const to = this.recipient(wallet, text);
    const a = await this.asset(wallet, asset);
    const body = { asset, to: to.toBase58() };
    return {
      nav: "push",
      screen: screen("", `Send ${phoneText(a.symbol, 12)}`, [
        stat("To", shortAddr(to.toBase58())),
        stat("You can send", `${fmtCompact(rawToUi(a.available, a.decimals))} ${a.symbol}`),
        row("Send 25%", Icon.Attachment, post("/ui/send/review", { ...body, percent: 25 }), NAV),
        row("Send 50%", Icon.Attachment, post("/ui/send/review", { ...body, percent: 50 }), NAV),
        row("Send all", Icon.Attachment, post("/ui/send/review", { ...body, percent: 100 }), NAV),
        row("Other amount", Icon.Email, { kind: "input", title: `Amount of ${phoneText(a.symbol, 12)} to send`, maxLength: 24, path: "/ui/send/review", field: "amount", body }, NAV),
      ]),
    };
  }

  private async reviewSend(wallet: Keypair, b: Record<string, unknown>): Promise<UiResponse> {
    const asset = String(b.asset ?? "");
    const to = this.recipient(wallet, String(b.to ?? ""));
    const a = await this.asset(wallet, asset);
    let raw: BN;
    if (b.percent !== undefined) {
      const percent = Number(b.percent);
      if (!Number.isFinite(percent) || percent <= 0 || percent > 100) throw new UserError("Percent must be 1-100.");
      raw = percent >= 100 ? a.available : a.available.muln(percent).divn(100);
    } else {
      raw = toRawAmount(b.amount, a.decimals);
    }
    if (raw.isZero()) throw new UserError("Nothing to send.");
    if (raw.gt(a.available)) throw new UserError(`You can send at most ${fmtCompact(rawToUi(a.available, a.decimals))} ${a.symbol}.`);
    if (asset === SOL && raw.lt(NEW_WALLET_MIN_LAMPORTS) && (await this.d.connection.getBalance(to, "confirmed")) === 0) {
      throw new UserError("A brand-new wallet needs at least 0.001 SOL.");
    }

    const id = this.sends.put({ asset, to, raw, decimals: a.decimals, symbol: a.symbol, program: a.program });
    const amount = `${rawToUi(raw, a.decimals)} ${a.symbol}`;
    const practice = this.d.config.dryRun;
    const rows = [
      stat("Send", phoneText(amount, 28)),
      info("To this address:"),
      ...this.addressLines(to.toBase58()),
      info("Check it. Sends can't be undone.", Icon.None, WARN),
      ...(practice ? [info("PRACTICE: simulate only", Icon.Lock, WARN)] : []),
      row("Cancel", Icon.RemoveTag, { kind: "back" }, PLAIN),
      practice
        ? row("SIMULATE SEND", Icon.Ticked, post("/ui/send/execute", { id }), PRIMARY)
        : row("CONFIRM SEND", Icon.Ticked, askPassword("Enter password", "To send this", "/ui/send/execute", { id }), SELL),
    ];
    return { nav: "push", screen: screen("", "Confirm send", rows, { selected: rows.length - 2 }) };
  }

  private async executeSend(wallet: Keypair, b: Record<string, unknown>): Promise<UiResponse> {
    const practice = this.d.config.dryRun;
    if (!practice) this.decrypt(b); // before taking it, so a mistyped password can be retried
    const p = this.sends.take(String(b.id ?? ""));
    if (!p) return { nav: "back", toast: { text: "That confirm screen expired. Try again.", level: "error" } };

    const built = await buildTx(this.d.connection, wallet.publicKey, this.sendInstructions(wallet.publicKey, p), [wallet], {
      computeUnitLimit: SEND_COMPUTE_UNITS,
      priorityFeeMicroLamports: this.d.config.priorityFeeMicroLamports,
    });
    const sim = await simulate(this.d.connection, built);
    if (!sim.ok) throw new UserError(sim.error ?? "This send would fail. Nothing was sent.");
    const signature = practice ? undefined : await (this.d.send ?? sendAndConfirm)(this.d.connection, built);

    const amount = rawToUi(p.raw, p.decimals);
    this.d.history.append({
      ts: Date.now(),
      kind: "send",
      mint: p.asset,
      symbol: p.symbol,
      sol: p.asset === SOL ? amount : 0,
      tokens: amount,
      signature,
      simulated: practice,
    });
    const header = practice ? "Simulated send" : "Sent";
    const text = `${amount} ${p.symbol}`;
    return {
      nav: "replace",
      screen: screen("", header, [
        info(phoneText(text, 34), Icon.Ticked),
        info(`to ${shortAddr(p.to.toBase58())}`, Icon.Ticked),
        ...(practice ? [info("Simulation OK. Nothing sent.", Icon.None, WARN)] : [stat("Tx", shortAddr(signature!))]),
        row("Done", Icon.Ticked, { kind: "home" }, PRIMARY),
      ], { selected: practice ? 3 : 3 }),
      toast: { text: `${header}: ${text}`, level: "success" },
    };
  }

  private sendInstructions(me: PublicKey, p: PendingSend): TransactionInstruction[] {
    if (p.asset === SOL) return [SystemProgram.transfer({ fromPubkey: me, toPubkey: p.to, lamports: BigInt(p.raw.toString()) })];
    const mint = new PublicKey(p.asset);
    const program = p.program!;
    const from = getAssociatedTokenAddressSync(mint, me, true, program);
    const to = getAssociatedTokenAddressSync(mint, p.to, true, program);
    return [
      createAssociatedTokenAccountIdempotentInstruction(me, to, p.to, mint, program),
      createTransferCheckedInstruction(from, mint, to, me, BigInt(p.raw.toString()), p.decimals, [], program),
    ];
  }

  // ---- backing up -----------------------------------------------------------

  private backupScreen(): Screen {
    const rows = [
      info("This key controls your wallet.", Icon.None, WARN),
      info("Anyone with it can take your SOL.", Icon.None, WARN),
      info("Don't show it on a stream.", Icon.None, WARN),
      row("Cancel", Icon.RemoveTag, { kind: "back" }, PLAIN),
      row("Show my key", Icon.Lock, askPassword("Enter password", "To show your key", "/ui/backup/reveal"), SELL),
    ];
    return screen("", "Export private key", rows, { selected: rows.length - 2 });
  }

  private revealKey(b: Record<string, unknown>): UiResponse {
    const key = bs58.encode(this.decrypt(b).secretKey);
    const lines = key.match(new RegExp(`.{1,${KEY_LINE_LENGTH}}`, "g")) ?? [];
    const rows = [
      info("Don't share this with anyone.", Icon.None, WARN),
      ...lines.map((line) => info(line)),
      row("Copy key", Icon.Attachment, post("/ui/backup/copy", { ticket: this.keyCopies.put(true) }), NAV),
      row("Done", Icon.Ticked, { kind: "back" }, PRIMARY),
    ];
    return { nav: "replace", screen: screen("", "Your private key", rows, { selected: rows.length - 1 }) };
  }

  /** Only someone who just gave the password has a ticket, and each works once. */
  private async copyKey(wallet: Keypair, b: Record<string, unknown>): Promise<UiResponse> {
    if (!this.keyCopies.take(String(b.ticket ?? ""))) throw new UserError("That expired. Show the key again.");
    await this.d.copy(bs58.encode(wallet.secretKey));
    return toast("Key copied. Paste it somewhere safe and offline.", "success");
  }

  // ---- practice or real money -----------------------------------------------

  private modeScreen(): Screen {
    if (!this.d.config.dryRun) {
      return screen("/ui/mode", "Real money", [
        info("Trades use real SOL.", Icon.None, WARN),
        row("Back to Practice", Icon.Lock, post("/ui/mode/practice"), PRIMARY),
      ]);
    }
    const rows = [
      info("Practice trades move no SOL."),
      info("Real trades use real SOL.", Icon.None, WARN),
      info("They can't be undone.", Icon.None, WARN),
      row("Stay in Practice", Icon.RemoveTag, { kind: "back" }, PLAIN),
      row("Use real money", Icon.Lock, askPassword("Enter password", "To turn on real trades", "/ui/mode/real"), SELL),
    ];
    return screen("/ui/mode", "Practice mode", rows, { selected: rows.length - 2 });
  }

  private useRealMoney(wallet: Keypair, b: Record<string, unknown>): UiResponse {
    this.decrypt(b);
    return this.setMode(wallet, false, "Real money is on: trades use real SOL");
  }

  private setMode(wallet: Keypair, dryRun: boolean, message: string): UiResponse {
    this.d.config.dryRun = dryRun;
    this.d.saveConfig(this.d.config);
    return { nav: "back", screen: this.settingsScreen(wallet), toast: { text: message, level: dryRun ? "info" : "success" } };
  }

  // ---- settings -------------------------------------------------------------

  private settingsScreen(wallet: Keypair): Screen {
    const address = shortAddr(wallet.publicKey.toBase58());
    const mode = this.d.config.dryRun ? "Practice" : "Real money";
    const slippage = `${this.d.engine.slippagePercent}%`;
    const max = `${fmtSol(this.d.config.maxSolPerTrade)} SOL`;
    return screen("/ui/settings", "Settings", [
      info("Wallet", Icon.None, { kind: "section" }),
      row(`Copy address ${address}`, Icon.Attachment, post("/ui/wallet/copy-address"), { kind: "nav", label: "Copy address", value: address, glyph: "copy" }),
      row("Export private key", Icon.Lock, open("/ui/backup"), { kind: "nav", glyph: "key" }),
      row("Change password", Icon.Lock, askPassword("Current password", "To change your password", "/ui/settings/password/current"), { kind: "nav", glyph: "lock" }),
      row("Lock wallet", Icon.Lock, post("/ui/lock"), { kind: "nav", glyph: "lock" }),
      info("Trading", Icon.None, { kind: "section" }),
      row(`Mode ${mode}`, Icon.Lock, open("/ui/mode"), { kind: "nav", label: "Mode", value: mode, glyph: "bolt" }),
      row(`Slippage ${slippage}`, Icon.Settings, open("/ui/settings/slippage"), { kind: "nav", label: "Slippage", value: slippage, glyph: "sliders" }),
      row(`Max per trade ${max}`, Icon.Settings, open("/ui/settings/max"), { kind: "nav", label: "Max per trade", value: max, glyph: "sliders" }),
      row(`RPC ${this.onRugrRpc() ? "RUGR" : this.rpcHost()}`, Icon.Settings, open("/ui/settings/rpc"), { kind: "nav", label: "RPC", value: this.onRugrRpc() ? "RUGR" : phoneText(this.rpcHost(), 22), glyph: "globe" }),
      info("Danger zone", Icon.None, { kind: "section" }),
      row("Reset wallet", Icon.Lock, open("/ui/reset"), { kind: "nav", glyph: "trash", tone: "danger" }),
    ], { selected: 1 });
  }

  private limitValue(kind: LimitKind): number {
    return kind === "slippage" ? this.d.engine.slippagePercent : this.d.config.maxSolPerTrade;
  }

  private limitScreen(kind: LimitKind): Screen {
    const limit = LIMITS[kind];
    const current = this.limitValue(kind);
    const rows: Row[] = [
      info(limit.about),
      ...limit.presets.map((value) =>
        row(`${value}${limit.unit}`, Icon.Settings, post("/ui/settings/set", { kind, value }), { kind: "nav", label: `${value}${limit.unit}`, value: value === current ? "Now" : undefined }),
      ),
      row("Other amount", Icon.Email, { kind: "input", title: limit.ask, maxLength: 8, path: "/ui/settings/set", field: "value", body: { kind } }, NAV),
    ];
    const now = limit.presets.findIndex((value) => value === current);
    return screen("", limit.title, rows, { selected: now >= 0 ? now + 1 : rows.length - 1 });
  }

  private setLimit(wallet: Keypair, b: Record<string, unknown>): UiResponse {
    const kind: LimitKind = b.kind === "max" ? "max" : "slippage";
    const limit = LIMITS[kind];
    const value = Number(String(b.value ?? "").trim().replace(",", "."));
    if (!Number.isFinite(value) || value < limit.min || value > limit.max) throw new UserError(`Enter a number from ${limit.min} to ${limit.max}.`);
    const current = this.limitValue(kind);
    if (value > current) {
      if (b.password === undefined) {
        return {
          nav: "replace",
          screen: screen("", `Raise ${limit.title.toLowerCase()}`, [
            stat("From", `${current}${limit.unit}`),
            stat("To", `${value}${limit.unit}`),
            info("A higher limit needs your password"),
            row("Enter password", Icon.Lock, askPassword("Enter password", `To raise it to ${value}${limit.unit}`, "/ui/settings/set", { kind, value }), SELL),
          ]),
        };
      }
      this.decrypt(b);
    }
    const c = this.d.config;
    if (kind === "slippage") {
      c.slippagePercent = value;
      this.d.engine.setSlippagePercent(value);
    } else {
      // The buy buttons can't go over the limit, or the config wouldn't load next time.
      const presets = [...new Set([...c.buyPresetsSol, ...DEFAULT_CONFIG.buyPresetsSol])].filter((p) => p <= value).sort((x, y) => x - y).slice(0, 8);
      c.maxSolPerTrade = value;
      c.buyPresetsSol = presets.length > 0 ? presets : [value];
    }
    this.d.saveConfig(c);
    return { nav: "back", screen: this.settingsScreen(wallet), toast: { text: `${limit.title}: ${value}${limit.unit}`, level: "success" } };
  }

  private rpcHost(): string {
    try {
      return new URL(this.d.config.rpcUrl).hostname;
    } catch {
      return "?";
    }
  }

  /** Whether the app goes through RUGR's own RPC, its server's, rather than one the player set. */
  private onRugrRpc(): boolean {
    return this.d.config.rpcUrl === `${this.d.config.apiUrl}/rpc`;
  }

  private rpcScreen(): Screen {
    const onRugr = this.onRugrRpc();
    return screen("", "RPC", [
      stat("Using", onRugr ? "RUGR's own" : phoneText(this.rpcHost(), 28)),
      info(onRugr ? "Fast and free; nothing to set up." : "Your own, not RUGR's."),
      info("Any https:// Solana RPC works too."),
      row("Paste RPC address", Icon.Attachment, post("/ui/settings/rpc/paste"), { kind: "button", tone: "primary", glyph: "paste" }),
      ...(onRugr ? [] : [row("Use RUGR's RPC", Icon.Settings, askPassword("Enter password", "To change the RPC", "/ui/settings/rpc/set", { url: `${this.d.config.apiUrl}/rpc` }), NAV)]),
    ]);
  }

  private checkRpc(text: unknown): string {
    const url = String(text ?? "").trim();
    try {
      validateConfig({ ...this.d.config, rpcUrl: url });
    } catch (e) {
      if (e instanceof ConfigError) throw new UserError("That isn't an https:// RPC address. Copy one first.");
      throw e;
    }
    return url;
  }

  private async pasteRpc(): Promise<UiResponse> {
    const url = this.checkRpc(await this.d.paste());
    return {
      nav: "replace",
      screen: screen("", "Change RPC", [
        stat("New RPC", phoneText(new URL(url).hostname, 28)),
        info("It sees your trades and balances."),
        info("Only use one you trust."),
        row("Enter password", Icon.Lock, askPassword("Enter password", "To change the RPC", "/ui/settings/rpc/set", { url }), SELL),
      ]),
    };
  }

  private setRpc(wallet: Keypair, b: Record<string, unknown>): UiResponse {
    const url = this.checkRpc(b.url);
    this.decrypt(b);
    this.d.config.rpcUrl = url;
    this.d.saveConfig(this.d.config);
    return { nav: "back", screen: this.settingsScreen(wallet), toast: { text: "Saved. It starts working next time you start the game.", level: "success" } };
  }

  // ---- changing the password ---

  private newPasswordScreen(): Screen {
    return screen("", "New password", [
      info("You can't recover it if forgotten", Icon.None, WARN),
      row("Choose new password", Icon.Lock, askPassword("New password", `At least ${MIN_PASSWORD_LENGTH} characters`, "/ui/settings/password/new", { ticket: this.passwordChanges.put(true) }), PRIMARY),
    ]);
  }

  private checkCurrentPassword(b: Record<string, unknown>): UiResponse {
    this.decrypt(b);
    return { nav: "push", screen: this.newPasswordScreen() };
  }

  /** Only someone who just gave the current password has a ticket, and each works once. */
  private takePasswordTicket(b: Record<string, unknown>): void {
    if (!this.passwordChanges.take(String(b.ticket ?? ""))) {
      throw new UserError("That expired. Start again from Settings.");
    }
  }

  private chooseNewPassword(b: Record<string, unknown>): UiResponse {
    const password = passwordIn(b);
    if (password.length < MIN_PASSWORD_LENGTH) throw new UserError(`Use at least ${MIN_PASSWORD_LENGTH} characters.`);
    if (password.length > MAX_PASSWORD_LENGTH) throw new UserError(`Use at most ${MAX_PASSWORD_LENGTH} characters.`);
    this.takePasswordTicket(b);
    this.pendingPassword = password;
    return {
      nav: "replace",
      screen: screen("", "Repeat password", [
        info("Type the same password again."),
        row("Repeat password", Icon.Lock, askPassword("Repeat password", "The same one again", "/ui/settings/password/repeat", { ticket: this.passwordChanges.put(true) }), PRIMARY),
      ]),
    };
  }

  private repeatNewPassword(wallet: Keypair, b: Record<string, unknown>): UiResponse {
    this.takePasswordTicket(b);
    const password = this.pendingPassword;
    this.pendingPassword = null;
    if (password === null || passwordIn(b) !== password) {
      return { nav: "replace", screen: this.newPasswordScreen(), toast: { text: "Passwords didn't match. Try again.", level: "error" } };
    }
    this.store.save(encryptKeypair(wallet, password, this.d.kdf ?? DEFAULT_KDF));
    return { nav: "back", screen: this.settingsScreen(wallet), toast: { text: "Password changed", level: "success" } };
  }

  // ---- locking and resetting ---

  private lock(): UiResponse {
    this.wallet = null;
    this.app = null;
    return { nav: "home", toast: { text: "Wallet locked", level: "info" } };
  }

  private async resetScreen(wallet: Keypair): Promise<Screen> {
    const [lamports, holdings] = await Promise.all([
      this.d.engine.solBalance(wallet.publicKey).catch(() => null),
      this.d.engine.holdings(wallet.publicKey).catch(() => []),
    ]);
    const held = lamports === null ? "Can't tell right now" : `${fmtSol(lamportsToSol(lamports))} SOL, ${holdings.length} token${holdings.length === 1 ? "" : "s"}`;
    const rows = [
      info("This takes the wallet out of RUGR.", Icon.None, WARN),
      info("Without its private key, anything", Icon.None, WARN),
      info("in it is lost for good.", Icon.None, WARN),
      stat("It holds", held),
      row("Cancel", Icon.RemoveTag, { kind: "back" }, PLAIN),
      row("Export private key first", Icon.Lock, open("/ui/backup"), NAV),
      row("Reset wallet", Icon.Lock, askPassword("Enter password", "To reset your wallet", "/ui/reset/confirm"), SELL),
    ];
    return screen("/ui/reset", "Reset wallet", rows, { selected: rows.length - 3 });
  }

  private resetWithPassword(b: Record<string, unknown>): UiResponse {
    this.decrypt(b);
    return this.removeWallet();
  }

  private forgotScreen(): Screen {
    const rows = [
      info("A password can't be recovered.", Icon.None, WARN),
      info("If you have your key, reset here,", Icon.None, WARN),
      info("then import it again.", Icon.None, WARN),
      info("With no key, the funds are lost.", Icon.None, WARN),
      row("Cancel", Icon.RemoveTag, { kind: "back" }, PLAIN),
      row("Reset wallet", Icon.Lock, { kind: "input", title: `Type ${RESET_WORD} to remove this wallet`, maxLength: 8, path: "/ui/reset/forgot", field: "confirm" }, SELL),
    ];
    return screen("", "Forgot password", rows, { selected: rows.length - 2 });
  }

  /** With no password to ask for, typing the word is the check. The encrypted file is
   * kept either way, so nothing is lost if the password turns up again. */
  private resetWithoutPassword(b: Record<string, unknown>): UiResponse {
    if (this.wallet || !this.store.exists()) return { nav: "home" };
    if (String(b.confirm ?? "").trim().toUpperCase() !== RESET_WORD) throw new UserError(`Type ${RESET_WORD} to reset. Nothing changed.`);
    return this.removeWallet();
  }

  private removeWallet(): UiResponse {
    this.store.remove();
    this.wallet = null;
    this.app = null;
    this.pendingPassword = null;
    this.pendingImport = null;
    this.d.history.clear();
    this.d.config.dryRun = true; // a new wallet starts in Practice, like any other
    this.d.saveConfig(this.d.config);
    return { nav: "home", toast: { text: "Wallet removed. An encrypted copy stays in the PumpV\\old-wallets folder.", level: "success" } };
  }
}
