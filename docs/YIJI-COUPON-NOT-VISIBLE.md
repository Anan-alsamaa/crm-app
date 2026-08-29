# Why the coupon notifies but is not in the app

_Read off Yiji's own Swagger, 2026-08-29. No coupon was issued to investigate
this._

Sources:

- `https://admin.yiji-app.com/swagger/v1/swagger.json` (1.9 MB)
- `https://mobileapi.yiji-app.com/swagger/v1/swagger.json` (713 KB)

---

## The finding

**The mobile app has exactly one endpoint for listing a customer's coupons, and
it lists GENERAL coupons. Ours are created as Private.**

```
/api/CouponUser/GetAllGeneralCoupon
  summary: "Get All General coupon by user"
  params:  UserId, TenantId
  returns: GeneralCouponUserVM[]
```

That is the **only** read path in the whole mobile spec that returns coupons for
a user. Every other coupon route there is a _redemption_ call
(`UseCoupon`, `UseCouponAsync`, `UseCouponByCouponId`, …), and each one needs a
`userCouponId` the customer can only have obtained from a list.

So the chain breaks in a very specific place:

| step                             | works?                                                 |
| -------------------------------- | ------------------------------------------------------ |
| We create the grant              | **yes** — receipts 21207, 21223, 21225, 21229 are real |
| Yiji notifies the customer       | **yes** — you see the notification                     |
| App lists the customer's coupons | **calls `GetAllGeneralCoupon`**                        |
| Our coupon appears in that list  | **no — it is `type: 1`, not General**                  |
| Customer redeems it              | impossible; they never got a `userCouponId`            |

We send `type: 1` because that is what Yiji's own correctly-built Private coupon
(70644) carries, and the CRM says "Private". That was right for _matching a
working coupon_ and appears to be wrong for _being visible in the app_.

---

## The evidence, and its limits

**What the spec proves.** `GetAllGeneralCoupon` is the sole user-facing coupon
list; its name and summary both say "General"; `CouponType` is an enum of
`0, 1, 2`.

**What it does not prove.** The specs carry **no enum names** — no
`x-enumNames`, nothing.

`CouponType` is now **confirmed by the owner (2026-08-29)**:

```
0 = General        1 = Private        2 = GeneralExclusive (unused for now)
```

which matches what was inferred from comparing two real coupons, and removes the
unexplained third value. `CouponCategory` `{0,1,2,3,4,5}` is still unlabelled —
we use 1 for Amount and 0 for Percentage, inferred the same way.

I also could not read a coupon back to confirm: `GetAllUserCoupons` returns
**403** for our service account, and `GetAllGeneralCoupon` returns **403**
because it wants a _customer's_ token, not ours. So the last mile is untested
from our side.

---

## Two candidate causes, in order

### 1. Coupon type (most likely)

If `GetAllGeneralCoupon` filters on type, a Private coupon simply is not in the
list the app renders. This fits the symptom exactly: created, notified, absent.

### 2. `assignee: []` (worth ruling out)

`CouponVM.assignee` is `CouponAssignementVM[]`, and ours is always empty.
Looking at the shape, this is **not** the customer link:

```
CouponAssignementVM { assignementId, assignementType, assigneeId, couponId }
```

`assigneeId` is an **integer**, and `AssignementType` is an enum of `0..8` —
that is a brand/restaurant/city style scope, not a customer GUID. The customer
link is the `CouponUser` row itself, which is what our receipt id refers to. So
this is probably not the cause, but it is the only other field that could gate
visibility, and it should be named when asking.

---

## Also found: an endpoint built for this exact job

```
/api/CouponUser/AddCompensationCoupon
  summary: "Add compensation coupon"
  body:    CouponUserVM
```

**It is an ALTERNATIVE, not a second step.** Worth stating plainly because the
names invite the opposite reading: you do not create a coupon and then
"register" it with this. There are three sibling create endpoints on the admin
API, and each one makes a grant on its own:

| endpoint                                    | body                | shape                  |
| ------------------------------------------- | ------------------- | ---------------------- |
| `CouponUserOrder/CreateCouponUserFromOrder` | `CouponUserOrderVM` | grant **+ order link** |
| `CouponUser/AddCompensationCoupon`          | `CouponUserVM`      | grant only             |
| `CouponUser/AddUserCoupon`                  | `CouponUserVM`      | grant only             |

`CouponUserOrderVM` is `{ couponUserId, couponUser, orderId, usedAmount, … }` —
it is the _join_ between a coupon-user grant and an order. That is precisely why
ours works without a Yiji customer id: the order identifies the customer.

So calling `AddCompensationCoupon` after our existing call would create a
SECOND, separate grant, not make the first one visible. If it turns out to be
the right endpoint we would **switch** to it, and lose the order link — which is
the one thing making walk-ins reachable. That trade is exactly why this is a
question for Yiji rather than a change to make.

The reason it is worth asking at all: an endpoint named for compensation may set
the type, visibility and reporting bucket correctly by itself, and none of that
is guessable from the schema.

---

## Confirmed while reading: `DeliveryType` is 1-based

```
DeliveryType: enum [1, 2, 3, 4, 5]
```

This settles a question that has been open for days. Their **order** API uses a
0-based delivery type (`0=delivery, 1=pickup, 2=carhop, 3=in_restaurant`,
verified against real orders), but the **coupon/mobile** vocabulary starts at 1
— which is why a correctly-built coupon carries `[3,1,2]` with no `0`.

`YIJI_DELIVERY_TYPE_CODE` in `coupon-request.ts` already assumes 1-based, so it
is consistent with this. The _labels_ are still unconfirmed — five values, and
we do not know which is which. Still one question, not two.

---

## The owner's test, and how to make it conclusive

The owner (2026-08-29) says a **Private coupon should be visible too**, and
proposes creating one by hand in the Yiji console as General and asking the
customer to look. That is a good test — it isolates the question and costs one
coupon.

One thing to watch, or the result will not be decidable. A coupon built by hand
in their console will almost certainly come out with **`deliveryTypes`
populated** (their own working coupon 70644 carries `[3,1,2]`), while ours sends
**nothing** for "All" and Yiji stores `[]`.

So a hand-built General coupon differs from ours in **two** ways, not one. If it
appears in the app, we still would not know whether `type` or `deliveryTypes`
was responsible.

**To make it conclusive, build the manual coupon to match ours in every respect
except the one being tested:**

| field                                         | set it to                   |
| --------------------------------------------- | --------------------------- |
| type                                          | **General** ← the variable  |
| deliveryTypes                                 | **leave empty**, as ours is |
| category                                      | Amount                      |
| discount / maximumDiscount                    | any small equal pair        |
| orderMinimum / orderMaximum                   | 0 / 10000                   |
| reachLimit / limitForUser / monthlyReachLimit | 1                           |
| all seven weekdays                            | true                        |

Then:

- **Visible** → `type` is the cause. `private` moves to `0` in
  `YIJI_COUPON_TYPE`, one line.
- **Not visible** → `type` is NOT the cause, and `deliveryTypes: []` becomes the
  leading suspect. That would be worth knowing on its own, because it is the
  same trap as `orderMaximum: 0`.

### Why `deliveryTypes: []` is a real suspect

We already learned once, painfully, that `0` is permissive on a floor and
**restrictive** on a ceiling in this API:

```
orderMinimum   0    no minimum spend       harmless
orderMaximum   0    ceiling of zero        KILLED THE COUPON
deliveryTypes  []   ??? no restriction, or valid on NO channel?
```

I assumed "no restriction" and said so in the code. That was the generous
reading and it may be wrong for exactly the same reason `orderMaximum` was: an
empty set of allowed channels can mean "any" or "none", and only one of those is
survivable. If the app asks "is this coupon valid for a channel I can order
through", `[]` hides it — created, notified, invisible.

---

## What to ask Yiji

Six questions. The first is the blocker; the rest are cheap while asking.

1. **A compensation coupon created via `CreateCouponUserFromOrder` notifies the
   customer but does not appear in the app. `GetAllGeneralCoupon` looks like the
   only list endpoint — should compensation coupons be `type: 0` (General) to be
   visible, or is there another endpoint the app uses?**
2. Is `AddCompensationCoupon` the intended endpoint for CRM-issued compensation,
   rather than `CreateCouponUserFromOrder`?
3. ~~`CouponType` names~~ — **answered**: 0 General, 1 Private,
   2 GeneralExclusive.
4. `CouponCategory` `{0,1,2,3,4,5}` — names for each? (We use 1 for Amount and
   0 for Percentage, inferred from a working coupon.)
5. `DeliveryType` `{1,2,3,4,5}` — which is which?
6. `issuingSideId` — the list of ids, so a coupon is attributed to the right
   department. And read access on `GetAllUserCoupons` for our service account,
   so we can verify a coupon after issuing it instead of asking you to look.

---

## What NOT to do

Do not flip `type` to `0` speculatively. It is a one-character change and it
would probably work — but "probably" here means changing what a coupon _is_ on
a live customer-facing system, and General may carry different visibility,
stacking or reporting semantics than Private. One answer from Yiji settles it;
a guess creates a second unknown on top of the first.

When the answer comes, the change is a single line in `YIJI_COUPON_TYPE`
(`packages/shared-types/src/coupon-request.ts`) — the mapping already lives in
one place for exactly this reason.
