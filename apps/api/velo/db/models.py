"""Every model, imported in one place.

Alembic's autogenerate and the schema tests need the complete metadata. Import
this module — never a domain's models — anywhere the whole schema is wanted.
"""

from velo.db.base import Base
from velo.domains.cart import models as cart
from velo.domains.catalog import models as catalog
from velo.domains.checkout import models as checkout
from velo.domains.discounts import models as discounts
from velo.domains.identity import models as identity
from velo.domains.inventory import models as inventory
from velo.domains.orders import models as orders
from velo.domains.payments import models as payments
from velo.domains.platform import job_failures
from velo.domains.platform import models as platform
from velo.domains.shipping import models as shipping
from velo.emails import models as emails

__all__ = [
    "Base",
    "cart",
    "catalog",
    "checkout",
    "discounts",
    "emails",
    "identity",
    "inventory",
    "job_failures",
    "orders",
    "payments",
    "platform",
    "shipping",
]
