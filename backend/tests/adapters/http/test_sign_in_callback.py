"""``GET /auth/callback``: completing the sign-in (task 7.2).

Spec: authentication, "Sign-in through the Environment's Keycloak" and
"Sessions are held by the server"; access-control, "Users without a role are
refused"; audit-log, "Recording unauthenticated failures" and "No action
without an Audit Entry" (issue #30 included).
"""

from __future__ import annotations

from urllib.parse import parse_qs, urlsplit

import httpx2
import pytest
from fastapi.testclient import TestClient

from podiumd_admin.adapters.db.unit_of_work import TransactionAbortedError
from podiumd_admin.domain.audit import Outcome, ReasonCode
from tests.adapters.http.conftest import CLIENT_IP, SESSION_COOKIE, SIGN_IN_COOKIE, AuthWorld
from tests.application.fakes import identity


def _query(location: str) -> dict[str, str]:
    return {key: values[0] for key, values in parse_qs(urlsplit(location).query).items()}


def _start(client: TestClient, return_to: str = "/audit-log") -> str:
    """Start a sign-in; return the state Keycloak would send back."""
    response = client.get("/auth/sign-in", params={"return_to": return_to})
    return _query(response.headers["location"])["state"]


def _callback(client: TestClient, **params: str) -> httpx2.Response:
    return client.get("/auth/callback", params=params)


def _cookie_attributes(response: httpx2.Response, name: str) -> set[str]:
    for header in response.headers.get_list("set-cookie"):
        if header.startswith(f"{name}="):
            return {part.strip().lower() for part in header.split(";")[1:]}
    raise AssertionError(f"no Set-Cookie for {name}")


def _assert_sign_in_cookie_cleared(response: httpx2.Response) -> None:
    """The sign-in cookie is cleared whatever the outcome: the attempt has been used."""
    assert any(
        attribute.startswith("max-age=0") or attribute.startswith("expires=")
        for attribute in _cookie_attributes(response, SIGN_IN_COOKIE)
    )


def test_a_successful_callback_signs_the_user_in(auth_client: TestClient, world: AuthWorld) -> None:
    state = _start(auth_client)

    response = _callback(auth_client, state=state, code="code-1")

    assert response.status_code == 302
    assert response.headers["location"] == "/audit-log"
    assert response.headers["cache-control"] == "no-store"
    session_id = response.cookies[SESSION_COOKIE]
    assert session_id in world.unit_of_work.sessions.sessions
    [entry] = world.unit_of_work.audit.entries
    assert (entry.action, entry.outcome, entry.client_ip) == ("sign-in", Outcome.ALLOWED, CLIENT_IP)
    assert len(entry.correlation_id) == 32


def test_the_session_cookie_is_a_host_only_secure_cookie(auth_client: TestClient) -> None:
    response = _callback(auth_client, state=_start(auth_client), code="code-1")

    attributes = _cookie_attributes(response, SESSION_COOKIE)
    assert {"httponly", "secure", "samesite=lax", "path=/"} <= attributes
    assert not any(
        attribute.startswith(("domain", "max-age", "expires")) for attribute in attributes
    )
    _assert_sign_in_cookie_cleared(response)


def test_a_presented_session_id_is_never_adopted(auth_client: TestClient, world: AuthWorld) -> None:
    auth_client.cookies.set(SESSION_COOKIE, "chosen-by-an-attacker")
    state = _start(auth_client)

    response = _callback(auth_client, state=state, code="code-1")

    session_id = response.cookies[SESSION_COOKIE]
    assert session_id != "chosen-by-an-attacker"
    assert set(world.unit_of_work.sessions.sessions) == {session_id}


def test_a_user_without_a_role_sees_the_no_access_page(
    auth_client: TestClient, world: AuthWorld
) -> None:
    world.identity_provider.identity = identity([])

    response = _callback(auth_client, state=_start(auth_client), code="code-1")

    assert response.status_code == 302
    assert response.headers["location"] == "/no-access"
    assert SESSION_COOKIE not in response.cookies
    _assert_sign_in_cookie_cleared(response)
    assert world.unit_of_work.sessions.sessions == {}
    [entry] = world.unit_of_work.audit.entries
    assert (entry.outcome, entry.reason) == (Outcome.DENIED, ReasonCode.NO_ROLE)


@pytest.mark.parametrize(
    ("params", "reason"),
    [
        ({"state": "forged-state", "code": "code-1"}, ReasonCode.INVALID_STATE),
        ({"code": "code-1"}, ReasonCode.INVALID_STATE),
        (
            {"error": "access_denied", "error_description": "<b>free text</b>"},
            ReasonCode.CALLBACK_ERROR,
        ),
    ],
)
def test_a_failed_callback_creates_no_session(
    auth_client: TestClient,
    world: AuthWorld,
    params: dict[str, str],
    reason: ReasonCode,
) -> None:
    state = _start(auth_client)
    if reason is ReasonCode.CALLBACK_ERROR:
        params = {**params, "state": state}

    response = _callback(auth_client, **params)

    assert response.status_code == 302
    location = response.headers["location"]
    assert urlsplit(location).path == "/sign-in-error"
    assert _query(location)["correlation_id"]
    assert "error" not in _query(location)
    assert SESSION_COOKIE not in response.cookies
    _assert_sign_in_cookie_cleared(response)
    assert world.unit_of_work.sessions.sessions == {}
    assert world.unit_of_work.audit.entries == []
    world.failures.flush_all()
    assert [(line.client_ip, line.reason, line.count) for line in world.sink.summaries] == [
        (CLIENT_IP, reason, 1)
    ]


def _assert_failed(response: httpx2.Response) -> None:
    assert response.status_code == 302
    location = response.headers["location"]
    assert urlsplit(location).path == "/sign-in-error"
    assert _query(location)["correlation_id"]
    assert SESSION_COOKIE not in response.cookies
    _assert_sign_in_cookie_cleared(response)


def _failures(world: AuthWorld) -> list[tuple[str | None, ReasonCode, int]]:
    world.failures.flush_all()
    return [(line.client_ip, line.reason, line.count) for line in world.sink.summaries]


def test_an_oversized_state_is_an_ordinary_failed_callback(
    auth_client: TestClient, world: AuthWorld
) -> None:
    """Not a 422: the attempt is used, the cookie cleared and the failure counted."""
    state = _start(auth_client)
    attempt_id = auth_client.cookies[SIGN_IN_COOKIE]

    response = _callback(auth_client, state="s" * 256, code="code-1")

    _assert_failed(response)
    auth_client.cookies.clear()
    auth_client.cookies.set(SIGN_IN_COOKIE, attempt_id)
    second = _callback(auth_client, state=state, code="code-1")
    _assert_failed(second)
    assert world.unit_of_work.sessions.sessions == {}
    assert world.identity_provider.exchanges == []
    assert _failures(world) == [(CLIENT_IP, ReasonCode.INVALID_STATE, 2)]


@pytest.mark.parametrize("param", ["code", "error"])
def test_an_oversized_code_or_error_is_an_ordinary_failed_callback(
    auth_client: TestClient, world: AuthWorld, param: str
) -> None:
    params = {"state": _start(auth_client), "code": "code-1", param: "x" * 5000}

    response = _callback(auth_client, **params)

    _assert_failed(response)
    assert world.identity_provider.exchanges == []
    assert _failures(world) == [(CLIENT_IP, ReasonCode.CALLBACK_ERROR, 1)]


def test_an_oversized_sign_in_cookie_is_an_ordinary_failed_callback(
    auth_client: TestClient, world: AuthWorld
) -> None:
    state = _start(auth_client)
    auth_client.cookies.clear()
    auth_client.cookies.set(SIGN_IN_COOKIE, "a" * 300)

    response = _callback(auth_client, state=state, code="code-1")

    _assert_failed(response)
    assert _failures(world) == [(CLIENT_IP, ReasonCode.INVALID_STATE, 1)]


def test_a_callback_without_the_sign_in_cookie_creates_no_session(
    auth_client: TestClient, world: AuthWorld
) -> None:
    state = _start(auth_client)
    auth_client.cookies.clear()

    response = _callback(auth_client, state=state, code="code-1")

    assert urlsplit(response.headers["location"]).path == "/sign-in-error"
    assert world.unit_of_work.sessions.sessions == {}


def test_an_audit_failure_creates_no_session_and_shows_the_error_page(
    auth_client: TestClient, world: AuthWorld
) -> None:
    state = _start(auth_client)
    world.unit_of_work.audit.error = RuntimeError("insert privilege revoked")

    response = _callback(auth_client, state=state, code="code-1")

    assert response.status_code == 302
    location = response.headers["location"]
    assert urlsplit(location).path == "/sign-in-error"
    assert _query(location)["error"] == "action-not-recorded"
    assert _query(location)["correlation_id"]
    assert SESSION_COOKIE not in response.cookies
    _assert_sign_in_cookie_cleared(response)
    assert world.unit_of_work.sessions.sessions == {}


def test_an_aborted_transaction_creates_no_session_and_shows_the_error_page(
    auth_client: TestClient, world: AuthWorld
) -> None:
    """Issue #30: surfaced as the existing "the action could not be recorded" error."""
    state = _start(auth_client)
    world.unit_of_work.abort_error = TransactionAbortedError
    world.unit_of_work.abort_next_audited_commit = True

    response = _callback(auth_client, state=state, code="code-1")

    assert _query(response.headers["location"])["error"] == "action-not-recorded"
    assert SESSION_COOKIE not in response.cookies
    _assert_sign_in_cookie_cleared(response)
    assert world.unit_of_work.sessions.sessions == {}
    assert world.sink.stored == []
