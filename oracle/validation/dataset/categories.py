"""Category labels for the validation dataset (plan §10 step 1, task O39.1).

Every row gets exactly one of CATEGORIES, decided per parent market so that all markets of one parent share it.
Polymarket rows take the category of the tag the event was pulled under (PM_PULLS, in precedence order: an
event that appears under several pulls keeps the first). Kalshi rows take their series' category through
KALSHI_CATEGORY; anything unmapped is "other".
"""

CATEGORIES = ("sports", "macro", "elections", "politics", "crypto", "companies", "other")

# (category, Polymarket tag id, tag label). Precedence: earlier pulls win for an event found in several.
PM_PULLS = (
    ("elections", 144, "Elections"),
    ("macro", 100328, "Economy"),
    ("macro", 159, "Fed"),
    ("companies", 1013, "Earnings"),
    ("companies", 107, "Business"),
    ("crypto", 21, "Crypto"),
    ("sports", 1, "Sports"),
    ("politics", 2, "Politics"),
)

# Recurring short-interval series (5-minute "Up or Down" and the like): automatic price markets that would
# swamp the crypto category and say nothing about resolution judgement. Excluded at the source.
PM_EXCLUDED_TAG_ID = 101757  # "Recurring"

# Kalshi series category -> dataset category.
KALSHI_CATEGORY = {
    "Sports": "sports",
    "Economics": "macro",
    "Financials": "macro",
    "Elections": "elections",
    "Politics": "politics",
    "Crypto": "crypto",
    "Companies": "companies",
}


def kalshi_category(series_category: str | None) -> str:
    return KALSHI_CATEGORY.get(series_category or "", "other")
