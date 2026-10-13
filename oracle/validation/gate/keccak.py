"""keccak256 (Ethereum's Keccak, not NIST SHA3-256: padding 0x01, not 0x06) and the few ABI encodings the gate needs.

The stdlib's hashlib.sha3_256 is FIPS-202 SHA3 and gives different digests, so the gate hashes (modelIdHash,
promptHash, categoryId, calibratorHash, gateHash, function selectors) use this Keccak-f[1600] sponge instead.
"""

from __future__ import annotations

_RC = [
    0x0000000000000001, 0x0000000000008082, 0x800000000000808A, 0x8000000080008000, 0x000000000000808B, 0x0000000080000001,
    0x8000000080008081, 0x8000000000008009, 0x000000000000008A, 0x0000000000000088, 0x0000000080008009, 0x000000008000000A,
    0x000000008000808B, 0x800000000000008B, 0x8000000000008089, 0x8000000000008003, 0x8000000000008002, 0x8000000000000080,
    0x000000000000800A, 0x800000008000000A, 0x8000000080008081, 0x8000000000008080, 0x0000000080000001, 0x8000000080008008,
]
_ROT = [[0, 36, 3, 41, 18], [1, 44, 10, 45, 2], [62, 6, 43, 15, 61], [28, 55, 25, 21, 56], [27, 20, 39, 8, 14]]
_M = (1 << 64) - 1


def _rol(x: int, n: int) -> int:
    return ((x << n) | (x >> (64 - n))) & _M if n else x


def _f(a: list[list[int]]) -> None:
    for rc in _RC:
        c = [a[x][0] ^ a[x][1] ^ a[x][2] ^ a[x][3] ^ a[x][4] for x in range(5)]
        d = [c[(x - 1) % 5] ^ _rol(c[(x + 1) % 5], 1) for x in range(5)]
        for x in range(5):
            for y in range(5):
                a[x][y] ^= d[x]
        b = [[0] * 5 for _ in range(5)]
        for x in range(5):
            for y in range(5):
                b[y][(2 * x + 3 * y) % 5] = _rol(a[x][y], _ROT[x][y])
        for x in range(5):
            for y in range(5):
                a[x][y] = b[x][y] ^ ((~b[(x + 1) % 5][y]) & b[(x + 2) % 5][y])
        a[0][0] ^= rc


def keccak256(data: bytes) -> bytes:
    rate = 136
    msg = bytearray(data) + b"\x01" + b"\x00" * ((-len(data) - 1) % rate)
    msg[-1] |= 0x80
    a = [[0] * 5 for _ in range(5)]
    for off in range(0, len(msg), rate):
        block = msg[off : off + rate]
        for i in range(rate // 8):
            a[i % 5][i // 5] ^= int.from_bytes(block[8 * i : 8 * i + 8], "little")
        _f(a)
    return b"".join(a[i % 5][i // 5].to_bytes(8, "little") for i in range(4))


def hex32(b: bytes) -> str:
    return "0x" + b.hex()


def k(text: str) -> str:
    """keccak256 of a string's UTF-8 bytes, as 0x-hex."""
    return hex32(keccak256(text.encode()))


def word(v: int | str | bool) -> bytes:
    """One ABI word: an unsigned integer, a bool, or a 0x-hex bytes32."""
    if isinstance(v, bool):
        v = int(v)
    if isinstance(v, int):
        if not 0 <= v < 2**256:
            raise ValueError(f"{v} does not fit a uint256")
        return v.to_bytes(32, "big")
    b = bytes.fromhex(v[2:])
    if len(b) != 32:
        raise ValueError(f"{v} is not 32 bytes")
    return b
