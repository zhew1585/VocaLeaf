"""What the narrator reads for a Sentence (PRD 4.2.6 rule 4): numbers, dates, years, money, percentages and
clock times spelled out as English words, so the TTS never guesses how to read digits. Display text keeps
the digits; only spoken_text goes through here."""

import re

_ONES = (
    *("zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"),
    *("eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"),
)
_TENS = ("", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety")
_SCALES = ((10**12, "trillion"), (10**9, "billion"), (10**6, "million"), (1000, "thousand"))
_IRREGULAR_ORDINALS = {
    "one": "first",
    "two": "second",
    "three": "third",
    "five": "fifth",
    "eight": "eighth",
    "nine": "ninth",
    "twelve": "twelfth",
}
_MONTHS = (
    "January|February|March|April|May|June|July|August|September|October|November|December"
    "|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec"
)
# (singular, plural) of the main unit and of its hundredth.
_CURRENCIES = {"$": (("dollar", "dollars"), ("cent", "cents")), "£": (("pound", "pounds"), ("penny", "pence"))}

_INT = r"[0-9]{1,3}(?:,[0-9]{3})+|[0-9]+"
_SCALE_WORDS = "|".join(name for _, name in _SCALES)
# A bare four-digit number in this range is far more often a year than a count in fiction.
_YEARS = range(1100, 2100)
# Read as "two thousand eight" rather than "twenty oh eight".
_TWO_THOUSANDS = range(2000, 2010)
_SUFFIX = r"(?:st|nd|rd|th)"
# One alternative per kind of number, tried left to right at each position; each names its own groups.
_PATTERN = re.compile(
    rf"""(?P<cur>[$£])(?P<amount>(?:{_INT})(?:\.[0-9]+)?)(?:\s+(?P<scale>{_SCALE_WORDS})\b)?
    |\b(?P<hour>[01]?[0-9]|2[0-3]):(?P<minute>[0-5][0-9])\b(?=(?P<meridiem>\s*[AaPp]\.?[Mm]\b)?)
    |\b(?P<month>{_MONTHS})\s+(?P<mday>[0-9]{{1,2}}){_SUFFIX}?\b
    |\b(?P<dday>[0-9]{{1,2}}){_SUFFIX}?\s+(?P<dmonth>{_MONTHS})\b
    |\b(?P<decade>[0-9]{{3}}0)s\b
    |\b(?P<ordinal>{_INT}){_SUFFIX}\b
    |\b(?P<percent>(?:{_INT})(?:\.[0-9]+)?)%
    |\b(?P<number>(?:{_INT})(?:\.[0-9]+)?)\b
    """,
    re.VERBOSE,
)


def spoken_text(text: str) -> str:
    """`text` with every number read out as words; everything else unchanged."""
    return _PATTERN.sub(_speak, text)


def _speak(m: re.Match[str]) -> str:
    g = m.groupdict()
    if g["cur"]:
        return _money(g["cur"], g["amount"], g["scale"])
    if g["hour"]:
        return _time(int(g["hour"]), int(g["minute"]), bool(g["meridiem"]))
    if g["month"]:
        return f"{g['month']} {_ordinal(int(g['mday']))}"
    if g["dday"]:
        return f"the {_ordinal(int(g['dday']))} of {g['dmonth']}"
    if g["decade"]:
        return _plural(_number(g["decade"]))
    if g["ordinal"]:
        return _ordinal(_int(g["ordinal"]))
    if g["percent"]:
        return f"{_number(g['percent'])} percent"
    return _number(g["number"])


def _cardinal(n: int) -> str:
    """1234 → "one thousand two hundred thirty-four"."""
    if n < 20:
        return _ONES[n]
    if n < 100:
        return _TENS[n // 10] + (f"-{_ONES[n % 10]}" if n % 10 else "")
    if n < 1000:
        return f"{_ONES[n // 100]} hundred" + (f" {_cardinal(n % 100)}" if n % 100 else "")
    for scale, name in _SCALES:
        if n >= scale:
            return f"{_cardinal(n // scale)} {name}" + (f" {_cardinal(n % scale)}" if n % scale else "")
    raise AssertionError("unreachable")


def _ordinal(n: int) -> str:
    """22 → "twenty-second"."""
    words = _cardinal(n)
    head, sep, last = words.rpartition("-") if "-" in words else words.rpartition(" ")
    if last in _IRREGULAR_ORDINALS:
        last = _IRREGULAR_ORDINALS[last]
    elif last.endswith("y"):
        last = last[:-1] + "ieth"
    else:
        last += "th"
    return f"{head}{sep}{last}"


def _year(n: int) -> str:
    """1811 → "eighteen eleven", 1905 → "nineteen oh five", 1900 → "nineteen hundred", 2008 → "two thousand eight"."""
    if n in _TWO_THOUSANDS:
        return _cardinal(n)
    high, low = divmod(n, 100)
    if low == 0:
        return f"{_cardinal(high)} hundred"
    return f"{_cardinal(high)} {'oh ' if low < 10 else ''}{_cardinal(low)}"


def _int(digits: str) -> int:
    return int(digits.replace(",", ""))


def _number(digits: str, years: bool = True) -> str:
    """A cardinal, a year (unless `years` is off) or a decimal ("three point one four") as written."""
    whole, _, fraction = digits.partition(".")
    if fraction:
        return f"{_cardinal(_int(whole))} point {' '.join(_ONES[int(d)] for d in fraction)}"
    if years and len(whole) == 4 and int(whole) in _YEARS:
        return _year(int(whole))
    return _cardinal(_int(whole))


def _plural(words: str) -> str:
    """ "seventeen ninety" → "seventeen nineties"."""
    return words[:-1] + "ies" if words.endswith("y") else words + "s"


def _money(symbol: str, amount: str, scale: str | None) -> str:
    """ "$3.50" → "three dollars and fifty cents", "$2.5 billion" → "two point five billion dollars"."""
    (one, many), (small_one, small_many) = _CURRENCIES[symbol]
    whole, _, fraction = amount.partition(".")
    if scale or (fraction and len(fraction) != 2):
        return f"{_number(amount, years=False)}{f' {scale}' if scale else ''} {many}"
    units, cents = _int(whole), int(fraction or 0)
    spoken = f"{_cardinal(units)} {one if units == 1 else many}"
    if cents:
        spoken += f" and {_cardinal(cents)} {small_one if cents == 1 else small_many}"
    return spoken


def _time(hour: int, minute: int, meridiem: bool) -> str:
    """10:30 → "ten thirty"; on the hour "ten o'clock", or just "ten" before a.m. or p.m."""
    if minute == 0:
        return _cardinal(hour) if meridiem else f"{_cardinal(hour)} o'clock"
    return f"{_cardinal(hour)} {'oh ' if minute < 10 else ''}{_cardinal(minute)}"
