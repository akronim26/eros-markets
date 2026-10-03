"""Task O39.3: the frozen gate (plan §8.3, §10 step 2).

The hashes are checked against values computed outside this code (viem's keccak256 and the panel runner's
modelIdHash and loadPrompts, run with bun on 4 Oct 2026; `cast` for the ABI encoding); the gate file is checked to
reproduce from the committed runs and to come from the train and calibration splits only.

  cd oracle/validation && python3 -m unittest tests/test_gate.py
"""

from __future__ import annotations

import copy
import json
import unittest
from fractions import Fraction

from gate import calibrate
from gate import gate as G
from gate.keccak import k, keccak256

from .fixtures_runs import linear_maps, rec

# bun: modelIdHash(model) from @eros-oracle/oracle-sdk
MODEL_ID_HASHES = [
    "0x0f88999d7b3d12fabb30fc17ed3deaae4dea955b3c47c97a3b2937fe3f4ff0e6",
    "0xde231ad8fec520538ddf8df926723c8f873e7880e1021e668b2544f8c6d5b994",
    "0xe60fedebae9f2662e68f00284c15c87f049fbfb1c603e834b40942b6b35fa721",
]
# bun: loadPrompts() of the panel runner: (categoryId, promptHash)
PROMPTS = {
    "sports": ("0xecf68b55a3148ada593e183bf15435fbd3f76364946ed2169f5e36e27bc9eafd", "0xd4e1459eb8c085de75bcd5bb4c97008561bdc896745e62eba6c28bb3fac70d82"),
    "macro": ("0x633c0a510dee69569e885970a8150a53097783b991dacaa795b37c38fa51a31c", "0x8fa86dfdf42ae6f6d99e890589bd57216a237907c3aebdab507faa3c992b7dd5"),
    "elections": ("0x792bedba023dd36f1e85d308c18b04a5f46709775d3cb22d87e3a64f100f88c0", "0xb159fb6f45d312cf1b833ec52bac83a6fc8e8afe83d9c19630b2be07e7ce2924"),
    "politics": ("0x244cf72cb284fc7d430637a0d0fe497a88146c8eb8832a06e8aaf72bcb0f75c8", "0x792057f16c13f22de4f812dd9cb71bed18c61446ff17bb2d2805dc9368855ee7"),
    "crypto": ("0x35006686fd78b85ed3fb52493d70cb3f7732177a19f352814df621b506c237a4", "0x1f1ae68717568abea858ad8c9bf417428b86844b1f4d40409be7f52a2556148b"),
    "companies": ("0xa59c9b8b4feb539d1bda063f59e1f5d3901d8243c55559a3f095f1e00cf32c0f", "0x51f500cab8f1eba4ccd19345df5293ca85693ddd950b1722bd63d80649122803"),
    "other": ("0x26b60b6bee32c2d284da42d089b795640a977077a3c25b246fe0448f42ce4ec0", "0xe6e03ecd09639ba46c496d7e7a364784326ffd46114b50bb5030e19c1a8b01fe"),
}


class Keccak(unittest.TestCase):
    def test_vectors(self):
        self.assertEqual(keccak256(b"").hex(), "c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470")
        self.assertEqual(keccak256(b"abc").hex(), "4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45")
        # viem keccak256 of 200 × "a" (two sponge blocks)
        self.assertEqual(keccak256(b"a" * 200).hex(), "96ea54061def936c4be90b518992fdc6f12f535068a256229aca54267b4d084d")
        for n in (135, 136, 137, 271, 272):  # around the 136-byte rate
            self.assertEqual(len(keccak256(b"x" * n)), 32)
        self.assertNotEqual(keccak256(b"x" * 135), keccak256(b"x" * 136))


class Hashes(unittest.TestCase):
    def test_model_and_prompt_hashes_match_the_panel_runner(self):
        self.assertEqual([k(m) for m in G.MODELS], MODEL_ID_HASHES)
        for c, (cid, ph) in PROMPTS.items():
            self.assertEqual((k(c), G.prompt_hash(c)), (cid, ph), c)

    def test_gate_hash_is_the_registry_encoding(self):
        # cast keccak $(cast abi-encode "f(bytes32[3],bytes32,bytes32,uint16)" [0x11..,0x22..,0x33..] 0x44.. 0x55.. 9100)
        h = G.gate_hash(["0x" + "11" * 32, "0x" + "22" * 32, "0x" + "33" * 32], "0x" + "44" * 32, "0x" + "55" * 32, 9100)
        self.assertEqual(h, "0x7965c8281ffaa9185bb2661bcc9196b2c6083c07f82da522801cb9369dacd31e")


class Theta(unittest.TestCase):
    def test_smallest_error_free_non_empty_bucket(self):
        maps = linear_maps()
        y3 = ["YES"] * 3
        train = [rec("train", "sports", "p1", "m1", "YES", y3, ["0.93"] * 3), rec("train", "sports", "p2", "m2", "NO", y3, ["0.91"] * 3)]
        self.assertEqual(G.choose_theta(train, maps)[0], 9200)  # 9,000 and 9,100 include the wrong m2
        train.append(rec("train", "sports", "p3", "m3", "NO", y3, ["0.95"] * 3))
        self.assertEqual(G.choose_theta(train, maps)[0], 9900)  # above m3 the bucket is empty: the fallback
        train.append(rec("train", "sports", "p4", "m4", "YES", y3, ["0.97"] * 3))
        self.assertEqual(G.choose_theta(train, maps)[0], 9600)  # above the wrong m3, with m4 in the bucket
        self.assertEqual(G.choose_theta([rec("train", "sports", "p1", "m1", "NO", ["NOT_YET"] * 3, ["0.99"] * 3)], maps), (9900, G.choose_theta([], maps)[1]))


class Committed(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.records = G.load_runs()
        cls.gate = json.loads(G.GATE_FILE.read_text())

    def test_gate_json_reproduces(self):
        gate, maps = G.freeze(self.records)
        self.assertEqual(gate, self.gate)
        self.assertEqual(calibrate.dumps_maps(maps), G.MAPS_FILE.read_text())

    def test_nothing_from_the_holdout(self):
        changed = copy.deepcopy(self.records)
        for r in changed:
            if r["split"] == "holdout":
                r["truth"] = "NO" if r["truth"] == "YES" else "YES"
                for o in r["outcomes"]:
                    o["label"], o["confidence"] = "YES", Fraction(99, 100)
        changed.append(rec("holdout", "macro", "px", "mx", "YES", ["YES"] * 3, ["0.99"] * 3))
        self.assertEqual(G.freeze(changed)[0]["categories"], self.gate["categories"])
        self.assertEqual(G.freeze(changed)[0]["highConfBps"], self.gate["highConfBps"])
        self.assertEqual(self.gate["derivedFrom"], ["train", "calibration"])

    def test_records_are_the_panels_models_and_pinned(self):
        self.assertEqual(json.loads(G.RUNS_FILE.read_text())["models"], list(G.MODELS))
        for r in self.records:
            self.assertEqual([o["model"] for o in r["outcomes"]], list(G.MODELS) if r["status"] == "RUN" else [])
        self.assertEqual(self.gate["data"]["runsSha256"], G.sha256_file(G.RUNS_FILE))
        self.assertEqual(self.gate["modelIdHashes"], MODEL_ID_HASHES)
        for c, (cid, ph) in PROMPTS.items():
            g = self.gate["categories"][c]
            self.assertEqual((g["categoryId"], g["promptHash"]), (cid, ph))
            self.assertEqual(g["gateHash"], G.gate_hash(MODEL_ID_HASHES, ph, self.gate["calibration"]["calibratorHash"], self.gate["highConfBps"]))


if __name__ == "__main__":
    unittest.main()
