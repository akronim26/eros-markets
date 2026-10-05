"""Committed JSON pins survive checkout newlines without weakening raw custody hashes."""
import hashlib
import tempfile
import unittest
from pathlib import Path

from gate.gate import sha256_file
from dataset.snapshot import sha256 as custody_sha256


class CommittedJsonHashes(unittest.TestCase):
    def test_checkout_newlines_only_are_normalized(self):
        body = b'{\n  "value": 1,\n  "escaped": "\\r\\n"\n}\n'
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "report.json"
            path.write_bytes(body)
            expected = sha256_file(path)
            self.assertEqual(expected, hashlib.sha256(body).hexdigest())
            path.write_bytes(body.replace(b"\n", b"\r\n"))
            self.assertEqual(sha256_file(path), expected)
            for changed in (body.replace(b'"value": 1', b'"value": 2'), body.replace(b"  ", b" "), body.replace(b"\\r\\n", b"\\n")):
                path.write_bytes(changed)
                self.assertNotEqual(sha256_file(path), expected)

    def test_binary_and_non_json_evidence_cannot_use_the_text_helper(self):
        with tempfile.TemporaryDirectory() as directory:
            for name, body in (("snapshot.tar.gz", b"binary\r\n"), ("report.json", b"not json\r\n")):
                path = Path(directory) / name
                path.write_bytes(body)
                with self.assertRaises(ValueError):
                    sha256_file(path)
        self.assertNotEqual(custody_sha256(b'{"raw":1}\n'), custody_sha256(b'{"raw":1}\r\n'))


if __name__ == "__main__":
    unittest.main()
