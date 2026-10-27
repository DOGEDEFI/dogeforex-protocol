#!/usr/bin/env python3
import json
import sys
from decimal import Decimal, ROUND_FLOOR, ROUND_HALF_UP, getcontext
from pathlib import Path

getcontext().prec = 50
ROOT = Path(__file__).resolve().parent


def normalized_yield(evidence):
    original = Decimal(evidence["originalYieldPercent"])
    formula = evidence["normalizationFormula"]
    if formula.startswith("identity"):
        return original
    if formula.startswith("100 * (exp("):
        return Decimal(100) * ((original / Decimal(100)).exp() - Decimal(1))
    if "discount" in evidence["originalUnit"] and evidence["tenor"] == "365 days":
        return Decimal(100) * original / (Decimal(100) - original)
    raise ValueError(f"Unsupported normalization for {evidence['code']}: {formula}")


def leadrate(evidence):
    normalized = normalized_yield(evidence)
    ppm = int((normalized * Decimal(10000) + Decimal("0.5")).to_integral_value(rounding=ROUND_FLOOR))
    return normalized, ppm + int(evidence["spreadPPM"])


def main():
    manifest = json.loads((ROOT / "initial-leadrates.json").read_text())
    instances = {entry["code"]: entry for entry in json.loads((ROOT / "instances" / "instances.json").read_text())}
    expected_codes = ["USD", "EUR", "JPY", "GBP", "AUD", "CNY", "BRL", "PKR", "BDT", "INR", "NGN"]
    rates = {entry["code"]: entry for entry in manifest["rates"]}
    if set(rates) != set(expected_codes) or set(instances) != set(expected_codes):
        raise ValueError("The manifest and instances must each contain exactly the expected 11 currencies")

    for code in expected_codes:
        evidence = rates[code]
        normalized, ppm = leadrate(evidence)
        if ppm != evidence["leadratePPM"] or ppm != instances[code]["leadratePPM"]:
            raise ValueError(f"{code}: computed {ppm} ppm, manifest/configuration mismatch")
        if not evidence["normalizationFormula"].startswith("identity"):
            rounded = normalized.quantize(Decimal("0.0000000001"), rounding=ROUND_HALF_UP)
            if rounded != Decimal(evidence["normalizedAnnualYieldPercent"]):
                raise ValueError(
                    f"{code}: computed normalized yield {rounded}, recorded {evidence['normalizedAnnualYieldPercent']}"
                )
        print(f"{code}: normalizedYieldPercent={normalized} leadratePPM={ppm}")
    print(f"Validated {len(expected_codes)} initial leadrates; no live data fetched and no files changed")


if __name__ == "__main__":
    try:
        main()
    except (KeyError, ValueError) as error:
        print(f"Rate validation failed: {error}", file=sys.stderr)
        sys.exit(1)
