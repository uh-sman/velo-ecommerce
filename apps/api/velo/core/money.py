"""Money as integer minor units with an ISO-4217 code (ADR-005).

``Money(2999, "USD")`` is $29.99. There is no float anywhere on this path:
construction rejects one, and arithmetic between two currencies is an error
rather than a silently wrong number. Formatting happens only at the display
edge, never here.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

_CURRENCY = re.compile(r"^[A-Z]{3}$")


class CurrencyMismatchError(ValueError):
    """Two amounts in different currencies were combined."""


@dataclass(frozen=True, slots=True)
class Money:
    amount: int
    currency: str

    def __post_init__(self) -> None:
        # bool is an int subclass; True dollars is a bug, not a value.
        if not isinstance(self.amount, int) or isinstance(self.amount, bool):
            raise TypeError(
                f"Money.amount must be an int of minor units, got {type(self.amount).__name__}."
            )
        if not isinstance(self.currency, str) or not _CURRENCY.match(self.currency):
            raise ValueError(f"Money.currency must be an ISO-4217 code, got {self.currency!r}.")

    @classmethod
    def zero(cls, currency: str) -> Money:
        return cls(0, currency)

    def _require_same_currency(self, other: Money) -> None:
        if self.currency != other.currency:
            raise CurrencyMismatchError(f"Cannot combine {self.currency} and {other.currency}.")

    def __add__(self, other: Money) -> Money:
        self._require_same_currency(other)
        return Money(self.amount + other.amount, self.currency)

    def __sub__(self, other: Money) -> Money:
        self._require_same_currency(other)
        return Money(self.amount - other.amount, self.currency)

    def __mul__(self, quantity: int) -> Money:
        """Multiply by a quantity. Rates are not quantities: see the pricing engine."""
        if not isinstance(quantity, int) or isinstance(quantity, bool):
            raise TypeError("Money can only be multiplied by an int quantity.")
        return Money(self.amount * quantity, self.currency)

    __rmul__ = __mul__

    def __neg__(self) -> Money:
        return Money(-self.amount, self.currency)

    def __lt__(self, other: Money) -> bool:
        self._require_same_currency(other)
        return self.amount < other.amount

    def __le__(self, other: Money) -> bool:
        self._require_same_currency(other)
        return self.amount <= other.amount

    def __gt__(self, other: Money) -> bool:
        self._require_same_currency(other)
        return self.amount > other.amount

    def __ge__(self, other: Money) -> bool:
        self._require_same_currency(other)
        return self.amount >= other.amount

    @property
    def is_zero(self) -> bool:
        return self.amount == 0

    @property
    def is_negative(self) -> bool:
        return self.amount < 0
