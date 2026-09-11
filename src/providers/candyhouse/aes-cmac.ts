const BLOCK_SIZE = 16;
const RB = 0x87;

export async function aesCmac(
  keyHex: string,
  message: Uint8Array,
  subtle: SubtleCrypto = crypto.subtle,
): Promise<string> {
  const keyBytes = hexToBytes(keyHex);
  if (keyBytes.length !== BLOCK_SIZE) {
    throw new TypeError(
      "Secret key must be exactly 32 hexadecimal characters.",
    );
  }

  const key = await subtle.importKey(
    "raw",
    toArrayBuffer(keyBytes),
    { name: "AES-CBC" },
    false,
    ["encrypt"],
  );
  const encryptBlock = async (block: Uint8Array): Promise<Uint8Array> => {
    const encrypted = await subtle.encrypt(
      { name: "AES-CBC", iv: new Uint8Array(BLOCK_SIZE) },
      key,
      toArrayBuffer(block),
    );
    return new Uint8Array(encrypted).slice(0, BLOCK_SIZE);
  };

  const zero = new Uint8Array(BLOCK_SIZE);
  const firstSubkey = doubleBlock(await encryptBlock(zero));
  const secondSubkey = doubleBlock(firstSubkey);
  const blockCount = Math.max(1, Math.ceil(message.length / BLOCK_SIZE));
  const completeLastBlock =
    message.length > 0 && message.length % BLOCK_SIZE === 0;
  let state: Uint8Array<ArrayBufferLike> = zero;

  for (let index = 0; index < blockCount - 1; index += 1) {
    const block = message.slice(index * BLOCK_SIZE, (index + 1) * BLOCK_SIZE);
    state = await encryptBlock(xor(state, block));
  }

  const lastStart = (blockCount - 1) * BLOCK_SIZE;
  const finalBlock = completeLastBlock
    ? xor(message.slice(lastStart, lastStart + BLOCK_SIZE), firstSubkey)
    : xor(pad(message.slice(lastStart)), secondSubkey);
  return bytesToHex(await encryptBlock(xor(state, finalBlock)));
}

export function sesameTimestampMessage(timestampSeconds: number): Uint8Array {
  if (
    !Number.isInteger(timestampSeconds) ||
    timestampSeconds < 0 ||
    timestampSeconds > 0xffffffff
  ) {
    throw new RangeError("Timestamp must be an unsigned 32-bit integer.");
  }
  return new Uint8Array([
    (timestampSeconds >>> 8) & 0xff,
    (timestampSeconds >>> 16) & 0xff,
    (timestampSeconds >>> 24) & 0xff,
  ]);
}

function doubleBlock(block: Uint8Array): Uint8Array {
  const output = new Uint8Array(BLOCK_SIZE);
  let carry = 0;
  for (let index = BLOCK_SIZE - 1; index >= 0; index -= 1) {
    const value = block[index] ?? 0;
    output[index] = ((value << 1) & 0xff) | carry;
    carry = (value & 0x80) === 0 ? 0 : 1;
  }
  if (carry !== 0) output[BLOCK_SIZE - 1] = (output[BLOCK_SIZE - 1] ?? 0) ^ RB;
  return output;
}

function pad(block: Uint8Array): Uint8Array {
  const output = new Uint8Array(BLOCK_SIZE);
  output.set(block);
  output[block.length] = 0x80;
  return output;
}

function xor(left: Uint8Array, right: Uint8Array): Uint8Array {
  const output = new Uint8Array(BLOCK_SIZE);
  for (let index = 0; index < BLOCK_SIZE; index += 1) {
    output[index] = (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return output;
}

function hexToBytes(value: string): Uint8Array {
  if (!/^[0-9a-f]+$/iu.test(value) || value.length % 2 !== 0) {
    throw new TypeError("Secret key must contain only hexadecimal characters.");
  }
  return Uint8Array.from(value.match(/.{2}/gu) ?? [], (pair) =>
    Number.parseInt(pair, 16),
  );
}

function bytesToHex(value: Uint8Array): string {
  return Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

function toArrayBuffer(value: Uint8Array): ArrayBuffer {
  return value.slice().buffer as ArrayBuffer;
}
