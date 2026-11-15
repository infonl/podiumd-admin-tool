"""Write-first auditing: no action without an Audit Entry.

Spec: audit-log, "No action without an Audit Entry". Design D4:

- An allowed action takes effect only after its Audit Entry has been
  inserted. If the insert fails, the action does not run and
  ``AuditWriteFailedError`` tells the caller the action could not be
  recorded, so the user can be shown that error.
- A denial is refused even when its Audit Entry cannot be stored. The failure
  is then written to stdout through the ``AuditSink``, exactly once, whether
  the transaction could not begin, the insert failed or the commit failed
  (``record_denial_in``).

For a database-only action, the caller runs ``record_then_act`` inside one
unit of work, so the insert and the action commit together. The stdout copy of
a stored entry is written by the adapters after the commit (D4), not here.
"""

from __future__ import annotations

import contextlib
from collections.abc import Awaitable, Callable

from podiumd_admin.domain.audit import AuditEntry, Outcome
from podiumd_admin.ports.audit import AuditRepository, AuditSink
from podiumd_admin.ports.unit_of_work import UnitOfWork


class AuditWriteFailedError(Exception):
    """An action's Audit Entry could not be stored, so the action did not take effect.

    The original storage error is chained as ``__cause__``.
    """

    def __init__(self, entry: AuditEntry) -> None:
        super().__init__(
            f"the action {entry.action!r} could not be recorded in the Audit Log "
            "and was not carried out"
        )
        self.entry = entry


class AuditRecorder:
    """Records Audit Entries before acting on them."""

    def __init__(self, *, repository: AuditRepository, sink: AuditSink) -> None:
        self._repository = repository
        self._sink = sink

    async def record_then_act[T](self, entry: AuditEntry, action: Callable[[], Awaitable[T]]) -> T:
        """Store the ``allowed`` ``entry``, then run ``action`` and return its result.

        Raises ``AuditWriteFailedError`` without running ``action`` if the entry
        could not be stored. An exception from ``action`` itself propagates
        unchanged; the entry then stays recorded, unless the caller's unit of
        work rolls both back.
        """
        if entry.outcome is not Outcome.ALLOWED:
            raise ValueError(f"record_then_act needs an allowed entry, got {entry.outcome}")
        error = await self._store(entry)
        if error is not None:
            raise AuditWriteFailedError(entry) from error
        return await action()

    async def record_denial(self, entry: AuditEntry) -> bool:
        """Store the ``denied`` ``entry``; the caller refuses the request either way.

        Returns whether the insert succeeded. A failed insert is written to
        stdout and does not raise, so it can never turn a denial into anything
        else. The insert can still be lost when the caller's transaction does
        not commit; ``record_denial_in`` reports that too.
        """
        _require_denied(entry)
        return await self._store(entry) is None

    async def _store(self, entry: AuditEntry) -> Exception | None:
        """Insert ``entry``; on failure report it to stdout and return the error.

        Only ``Exception`` is caught: cancellation and interpreter exits are
        not audit failures and propagate. If the stdout report fails as well,
        that error is dropped: there is nowhere left to report it, and raising
        it would mask the storage error, so ``record_then_act`` would not raise
        ``AuditWriteFailedError`` and ``record_denial`` would raise.
        """
        try:
            await self._repository.add(entry)
        except Exception as error:
            with contextlib.suppress(Exception):
                self._sink.audit_write_failed(entry, error)
            return error
        return None


async def record_denial_in(unit_of_work: UnitOfWork, sink: AuditSink, entry: AuditEntry) -> None:
    """Store the ``denied`` ``entry`` in its own transaction; never raises for a failure.

    The caller refuses the request either way. Every way the entry can fail to
    be stored is written to stdout exactly once: a transaction that cannot
    begin (the database is unreachable), a failed insert (reported by
    ``record_denial``; the commit of the transaction it aborted then raises
    and is not reported again), or a commit that fails after the insert. If
    that stdout report fails as well, it is dropped, as in ``_store``. Only
    ``Exception`` is caught, so cancellation propagates.
    """
    _require_denied(entry)
    insert_failure_reported = False
    try:
        async with unit_of_work.begin() as transaction:
            recorder = AuditRecorder(repository=transaction.audit_repository, sink=sink)
            insert_failure_reported = not await recorder.record_denial(entry)
    except Exception as error:
        if not insert_failure_reported:
            with contextlib.suppress(Exception):
                sink.audit_write_failed(entry, error)


def _require_denied(entry: AuditEntry) -> None:
    if entry.outcome is not Outcome.DENIED:
        raise ValueError(f"record_denial needs a denied entry, got {entry.outcome}")
