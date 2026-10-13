# Validation reproducibility

Run the committed validation checks with `python -m unittest discover -s tests -t .` from this directory. The panel-runner install and Bun enable the cross-language calibrator-hash check. Tests requiring the unpublished raw dataset remain explicit skips when it is absent.

The committed split, run, gate, calibration and measurement JSON reports are pinned as UTF-8 bytes with LF line endings. `gate.gate.sha256_file` normalizes only CRLF checkout line endings for those JSON files. It does not reserialize JSON: whitespace, key order, escaped strings and values still change their hashes. Frozen reports and expected hashes are not regenerated to accommodate a Windows checkout.

Raw provider bodies, raw manifests, normalized dataset rows and compressed snapshots continue to use their original byte-for-byte custody hashes in `dataset/` and `split/`. These are independent of the committed report-text helper.
