"""
Legacy-styled credit union back-office stand-in.
Server-rendered HTML only (Flask + render_template_string). No JSON/API
routes, no client-side JS frameworks. Built as an automation test target.
"""
import os
import time
from urllib.parse import urlencode

from flask import Flask, request, session, redirect, url_for, render_template_string

app = Flask(__name__)
app.secret_key = os.environ.get("SECRET_KEY", "dev-secret-key-change-me")

OPERATOR_USER = os.environ.get("OPERATOR_USER", "operator")
OPERATOR_PASS = os.environ.get("OPERATOR_PASS", "changeme123")

# --------------------------------------------------------------------------
# Tenant configuration
# --------------------------------------------------------------------------
TENANTS = {
    "first_credit_union": {
        "name": "First Credit Union",
        "header": "First Credit Union &mdash; Back Office",
        "search_label": "Member ID",
        "search_btn": "Search",
        "extra_nav": None,
    },
    "riverbend": {
        "name": "Riverbend Financial",
        "header": "Riverbend Financial &mdash; Teller Console",
        "search_label": "Account Number",
        "search_btn": "Find",
        "extra_nav": "Reports",
    },
}
TENANT = os.environ.get("TENANT", "first_credit_union")
CFG = TENANTS.get(TENANT, TENANTS["first_credit_union"])

# --------------------------------------------------------------------------
# Seed data (no database)
# --------------------------------------------------------------------------
MEMBERS = {
    "10001": {
        "name": "Jane A. Whitfield",
        "accounts": [
            {"type": "Savings", "acct_no": "SV-100231", "balance": 2450.10},
            {"type": "Checking", "acct_no": "CK-100232", "balance": 812.33},
            {"type": "Share Certificate", "acct_no": "CD-100233", "balance": 5000.00},
        ],
    },
    "10002": {"permission_denied": True},
    "10003": {
        "name": "Harold T. Nguyen",
        "slow": True,
        "accounts": [
            {"type": "Savings", "acct_no": "SV-100341", "balance": 1120.55},
            {"type": "Checking", "acct_no": "CK-100342", "balance": 340.02},
        ],
    },
    "10004": {"server_error": True},
}


def fmt_currency(x):
    return "${:,.2f}".format(x)


# --------------------------------------------------------------------------
# Shared markup helpers (deliberately table-based, minimally styled)
# --------------------------------------------------------------------------
CSS = """
body { font-family: Verdana, Arial, sans-serif; font-size: 12px; background: #d4d0c8; margin:0; padding:0; }
table.outer { width:100%; border-collapse:collapse; }
.hdr_ctr { background:#003366; color:#fff; padding:6px 10px; font-weight:bold; font-size:15px; }
table.nav_tbl { background:#c0c0c0; width:100%; border-collapse:collapse; }
table.nav_tbl td { padding:3px 10px; border-right:1px solid #999; }
table.nav_tbl a { color:#003366; text-decoration:none; font-weight:bold; }
.body_td { padding:12px; }
table.tbl1 { border-collapse:collapse; background:#fff; }
table.tbl1 td, table.tbl1 th { border:1px solid #999; padding:4px 8px; }
table.tbl1 th { background:#e8e8e8; }
.frm_fld { padding:3px 6px; }
.msg_err { border:2px solid #cc0000; background:#ffe5e5; color:#900; padding:8px; margin:8px 0; font-weight:bold; }
.msg_ok { border:2px solid #006600; background:#e5ffe5; color:#060; padding:8px; margin:8px 0; font-weight:bold; }
.msg_warn { border:2px solid #cc9900; background:#fff3cd; color:#663c00; padding:8px; margin:8px 0; }
.btn_div { display:inline-block; border:1px outset #ccc; background:#e0e0e0; padding:3px 10px; cursor:pointer; }
.btn_danger { background:#cc0000; color:#fff; font-weight:bold; padding:6px 14px; border:2px outset #900; cursor:pointer; }
"""

PAGE_TMPL = """<html><head><title>{{ title }}</title><style>{{ css }}</style></head>
<body>
<table class="outer"><tr><td class="hdr_ctr">{{ header|safe }}</td></tr>
{% if show_nav %}
<tr><td>
<table class="nav_tbl"><tr>
<td><a href="/search">Search</a></td>
{% if extra_nav %}<td><a href="#">{{ extra_nav }}</a></td>{% endif %}
<td><a href="/login?expire=1">Logout</a></td>
</tr></table>
</td></tr>
{% endif %}
<tr><td class="body_td">{{ body|safe }}</td></tr>
</table>
</body></html>"""


def page(title, body, show_nav=True):
    return render_template_string(
        PAGE_TMPL,
        title=title,
        css=CSS,
        header=CFG["header"],
        show_nav=show_nav,
        extra_nav=CFG["extra_nav"],
        body=body,
    )


def bare_page(body):
    return "<html><head><style>{}</style></head><body>{}</body></html>".format(CSS, body)


def interstitial_response():
    args = request.args.to_dict(flat=True)
    args.pop("interstitial", None)
    continue_url = request.path
    if args:
        continue_url += "?" + urlencode(args)
    body = """
    <div class="msg_warn">
    <h3>Scheduled System Maintenance</h3>
    <p>This system is currently undergoing scheduled maintenance. Some functions may be delayed.</p>
    <form method="GET" action="{}">
    <input type="submit" value="Continue">
    </form>
    </div>
    """.format(continue_url)
    return page("Scheduled Maintenance", body, show_nav=("operator" in session))


# --------------------------------------------------------------------------
# Global auth / flag handling
# --------------------------------------------------------------------------
@app.before_request
def before_request():
    if request.args.get("expire") == "1":
        session.clear()
        return redirect(url_for("login", msg="expired"))

    if request.endpoint not in ("login", "static") and "operator" not in session:
        return redirect(url_for("login", msg="expired"))

    if request.args.get("interstitial") == "1":
        return interstitial_response()


# --------------------------------------------------------------------------
# Login
# --------------------------------------------------------------------------
@app.route("/login", methods=["GET", "POST"])
def login():
    err = None
    if request.method == "POST":
        u = request.form.get("txtUser", "")
        p = request.form.get("txtPass", "")
        if u == OPERATOR_USER and p == OPERATOR_PASS:
            session["operator"] = u
            return redirect(url_for("search"))
        err = "Invalid operator credentials."
    elif request.args.get("msg") == "expired":
        err = "Session expired. Please log in again."

    err_html = '<div class="msg_err">{}</div>'.format(err) if err else ""
    body = """
    {err}
    <form method="POST" action="/login">
    <table class="tbl1">
    <tr><td class="frm_fld"><label for="txtUser">Operator ID</label></td>
    <td class="frm_fld"><input type="text" name="txtUser" id="txtUser"></td></tr>
    <tr><td class="frm_fld"><label for="txtPass">Password</label></td>
    <td class="frm_fld"><input type="password" name="txtPass" id="txtPass"></td></tr>
    </table>
    <input type="submit" name="btnSubmit" value="Log In">
    </form>
    """.format(err=err_html)
    return page("Operator Login", body, show_nav=False)


# --------------------------------------------------------------------------
# Search
# --------------------------------------------------------------------------
@app.route("/search", methods=["GET", "POST"])
def search():
    err_html = ""
    if request.method == "POST":
        mid = request.form.get("f_mbr_id", "").strip()
        if mid in MEMBERS:
            return redirect(url_for("member_detail", mid=mid))
        err_html = '<div class="msg_err">No member found</div>'

    body = """
    {err}
    <form method="POST" action="/search">
    <table class="tbl1">
    <tr>
    <td class="frm_fld"><label for="f_mbr_id">{label}</label></td>
    <td class="frm_fld"><input type="text" name="f_mbr_id" id="f_mbr_id"></td>
    <td class="frm_fld"><input type="submit" value="{btn}"></td>
    </tr>
    </table>
    </form>
    <p>
    <input type="text" name="txtSearch" placeholder="quick filter">
    <div class="btn_div" onclick="alert('Advanced search not available');">Advanced</div>
    </p>
    """.format(err=err_html, label=CFG["search_label"], btn=CFG["search_btn"])
    return page("Member Search", body)


# --------------------------------------------------------------------------
# Member detail / panel
# --------------------------------------------------------------------------
@app.route("/member/<mid>")
def member_detail(mid):
    m = MEMBERS.get(mid)
    if not m:
        return page("Member Search", '<div class="msg_err">No member found</div>')
    if m.get("permission_denied"):
        return page("Member {}".format(mid),
                     '<div class="msg_err">You do not have permission to view this member.</div>')
    if m.get("server_error"):
        return page("Error", '<div class="msg_err">Internal Server Error. Please contact system administrator.</div>'), 500
    if m.get("slow"):
        time.sleep(8)

    body = """
    <table class="tbl1">
    <tr><td style="width:120px;"><b>Name</b></td><td>{name}</td></tr>
    <tr><td><b>Member ID</b></td><td>{mid}</td></tr>
    </table>
    <p><b>Accounts</b></p>
    <iframe src="/member/{mid}/panel" style="width:100%;height:220px;border:1px solid #888;background:#fff;"></iframe>
    <p>
    <form method="POST" action="/member/{mid}/close" style="display:inline;">
    <input type="submit" value="Close Account" class="btn_danger">
    </form>
    </p>
    """.format(name=m["name"], mid=mid)
    return page("Member {}".format(mid), body)


@app.route("/member/<mid>/panel")
def member_panel(mid):
    m = MEMBERS.get(mid)
    if not m or m.get("permission_denied"):
        return bare_page('<div class="msg_err">No account data available.</div>')
    if m.get("server_error"):
        return bare_page('<div class="msg_err">Internal Server Error.</div>'), 500

    rows = "".join(
        "<tr><td>{type}</td><td>{acct}</td><td>{bal}</td></tr>".format(
            type=a["type"], acct=a["acct_no"], bal=fmt_currency(a["balance"])
        )
        for a in m["accounts"]
    )
    body = """
    <table class="tbl1">
    <tr><th>Type</th><th>Account No</th><th>Balance</th></tr>
    {rows}
    </table>
    """.format(rows=rows)
    return bare_page(body)


@app.route("/member/<mid>/close", methods=["POST"])
def member_close(mid):
    if mid not in MEMBERS:
        return page("Member Search", '<div class="msg_err">No member found</div>')
    body = """
    <div class="msg_warn">
    <b>Warning:</b> Closing this account is permanent and cannot be undone.
    </div>
    <form method="POST" action="/member/{mid}/close/confirm" style="display:inline;">
    <input type="submit" value="Confirm Close" class="btn_danger">
    </form>
    <form method="GET" action="/member/{mid}" style="display:inline;">
    <input type="submit" value="Cancel">
    </form>
    """.format(mid=mid)
    return page("Confirm Close - Member {}".format(mid), body)


@app.route("/member/<mid>/close/confirm", methods=["POST"])
def member_close_confirm(mid):
    body = """
    <div class="msg_ok">Account {mid} has been closed.</div>
    <p><a href="/search">Return to Search</a></p>
    """.format(mid=mid)
    return page("Account Closed", body)


# --------------------------------------------------------------------------
# Subaccount creation
# --------------------------------------------------------------------------
@app.route("/member/<mid>/subaccount/new", methods=["GET", "POST"])
def subaccount_new(mid):
    if mid not in MEMBERS:
        return page("Member Search", '<div class="msg_err">No member found</div>')

    if request.method == "POST":
        session["pending_sub_" + mid] = {
            "acct_type": request.form.get("f_acct_type", ""),
            "nickname": request.form.get("f_nickname", ""),
            "deposit": request.form.get("f_deposit", ""),
        }
        return redirect(url_for("subaccount_confirm", mid=mid))

    body = """
    <form method="POST" action="/member/{mid}/subaccount/new">
    <table class="tbl1">
    <tr><td class="frm_fld"><label for="f_acct_type">Account Type</label></td>
    <td class="frm_fld"><select name="f_acct_type" id="f_acct_type">
    <option>Savings</option><option>Checking</option><option>Share Certificate</option>
    </select></td></tr>
    <tr><td class="frm_fld"><label for="f_nickname">Nickname</label></td>
    <td class="frm_fld"><input type="text" name="f_nickname" id="f_nickname"></td></tr>
    <tr><td class="frm_fld"><label for="f_deposit">Initial Deposit</label></td>
    <td class="frm_fld"><input type="text" name="f_deposit" id="f_deposit"></td></tr>
    </table>
    <input type="submit" name="btnSubmit" value="Submit">
    </form>
    """.format(mid=mid)
    return page("New Subaccount - Member {}".format(mid), body)


@app.route("/member/<mid>/subaccount/confirm", methods=["GET", "POST"])
def subaccount_confirm(mid):
    key = "pending_sub_" + mid
    pending = session.get(key)

    if request.method == "POST":
        session.pop(key, None)
        body = """
        <div class="msg_ok">Subaccount created for member {mid}.</div>
        <p><a href="/member/{mid}">Return to Member</a></p>
        """.format(mid=mid)
        return page("Subaccount Created", body)

    if not pending:
        return redirect(url_for("subaccount_new", mid=mid))

    body = """
    <table class="tbl1">
    <tr><td><b>Account Type</b></td><td>{acct_type}</td></tr>
    <tr><td><b>Nickname</b></td><td>{nickname}</td></tr>
    <tr><td><b>Initial Deposit</b></td><td>{deposit}</td></tr>
    </table>
    <form method="POST" action="/member/{mid}/subaccount/confirm" style="display:inline;">
    <input type="submit" value="Confirm">
    </form>
    <form method="GET" action="/member/{mid}/subaccount/new" style="display:inline;">
    <input type="submit" value="Cancel">
    </form>
    """.format(mid=mid, **pending)
    return page("Confirm Subaccount - Member {}".format(mid), body)


# --------------------------------------------------------------------------
@app.route("/")
def index():
    return redirect(url_for("search"))


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "5000"))
    app.run(host="127.0.0.1", port=port, debug=False)
