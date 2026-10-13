"""Port of OpenFront PseudoRandom (from public client bundle) and simpleHash."""
M = 0xFFFFFFFF
def i32(x):
    x &= M
    return x - (1 << 32) if x & 0x80000000 else x
def imul(a, b): return i32((a & M) * (b & M))
def simple_hash(s):
    t = 0
    for ch in s:
        t = i32((t << 5) - t + ord(ch))
    return abs(t)
class PRNG:
    def __init__(self, seed):
        t = i32(seed)
        def n():
            nonlocal t
            t = i32(t + 2654435769)
            e = t ^ ((t & M) >> 16)
            e = imul(e, 569420461)
            e ^= (e & M) >> 15
            e = imul(e, 1935289751)
            return i32(e ^ ((e & M) >> 15))
        self.s0 = n(); self.s1 = n(); self.s2 = n(); self.s3 = n()
        for _ in range(12): self.next()
    def next(self):
        e = i32(i32(self.s0 + self.s1) + self.s3)
        self.s3 = i32(self.s3 + 1)
        self.s0 = i32(self.s1 ^ ((self.s1 & M) >> 9))
        self.s1 = i32(self.s2 + i32(self.s2 << 3))
        self.s2 = i32(i32(self.s2 << 21) | ((self.s2 & M) >> 11))
        self.s2 = i32(self.s2 + e)
        return (e & M) / 4294967296
    def next_id(self):
        v = int(self.next() * 2821109907456)
        d = "0123456789abcdefghijklmnopqrstuvwxyz"; out = ""
        while v: v, r = divmod(v, 36); out = d[r] + out
        return out.rjust(8, "0")
