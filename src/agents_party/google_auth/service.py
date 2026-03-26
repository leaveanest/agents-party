"""Google OAuth coordination logic for FastAPI routes and future callers."""

from __future__ import annotations

import asyncio
import secrets
from collections.abc import Sequence
from datetime import timedelta
import re
from typing import Protocol
from urllib.parse import urlsplit

from agents_party.domain.google_auth import (
    GOOGLE_OAUTH_SCOPES,
    GoogleAuthConnectionDocument,
    GoogleConnectionStatus,
    GoogleOAuthCallbackResult,
    GoogleOAuthStartContext,
    GoogleOAuthStateDocument,
    GoogleOAuthStateToken,
)
from agents_party.domain.slack_documents import utc_now
from agents_party.infrastructure.google_auth import (
    GoogleOAuthContextSignerError,
    GoogleOAuthGatewayError,
    TokenCipherError,
)
from agents_party.repositories.google_auth_connection_repository import (
    GoogleAuthConnectionRepository,
)
from agents_party.repositories.google_oauth_gateway import GoogleOAuthGateway
from agents_party.repositories.google_oauth_state_repository import (
    GoogleOAuthStateRepository,
)


class GoogleOAuthFlowError(RuntimeError):
    """Raised when the Google OAuth flow cannot continue."""

    def __init__(
        self,
        message: str,
        *,
        code: str,
        status_code: int,
        redirect_after_connect: str | None = None,
    ) -> None:
        """Initialize the Google OAuth flow error.

        Args:
            message: Human-readable failure message.
            code: Stable machine-readable error code.
            status_code: HTTP status code that best represents the error.
            redirect_after_connect: Optional redirect target to preserve UX flow.

        Returns:
            None.
        """
        super().__init__(message)
        self.code = code
        self.status_code = status_code
        self.redirect_after_connect = redirect_after_connect


class GoogleOAuthContextSignerProtocol(Protocol):
    """Protocol for issuing and verifying signed OAuth start contexts."""

    def dumps(self, context: GoogleOAuthStartContext) -> str:
        """Serialize and sign a Google OAuth start context.

        Args:
            context: Context payload to serialize.

        Returns:
            Signed token suitable for the public `context` query parameter.
        """

        ...

    def loads(self, token: str) -> GoogleOAuthStartContext:
        """Verify and deserialize a signed Google OAuth start context.

        Args:
            token: Signed context token from the public `context` query parameter.

        Returns:
            Verified Google OAuth start context.
        """

        ...

    def dumps_state_token(self, state_token: GoogleOAuthStateToken) -> str:
        """Serialize and encrypt an OAuth callback state token.

        Args:
            state_token: Callback state token payload to encrypt.

        Returns:
            Opaque token suitable for the OAuth `state` query parameter.
        """

        ...

    def loads_state_token(self, token: str) -> GoogleOAuthStateToken:
        """Decrypt and deserialize an OAuth callback state token.

        Args:
            token: Opaque `state` token from the OAuth callback query parameter.

        Returns:
            Verified OAuth callback state token payload.
        """

        ...


class TokenCipherProtocol(Protocol):
    """Protocol for encrypting and decrypting stored OAuth tokens."""

    def encrypt(self, value: str) -> str:
        """Encrypt a plaintext token string.

        Args:
            value: Plaintext token to encrypt.

        Returns:
            Encrypted token string.
        """

        ...

    def decrypt(self, value: str) -> str:
        """Decrypt an encrypted token string.

        Args:
            value: Encrypted token string to decrypt.

        Returns:
            Decrypted plaintext token string.
        """

        ...


class GoogleAuthCoordinator:
    """Coordinate Google OAuth start, callback, refresh, and revoke flows."""

    _STATE_ID_PATTERN = re.compile(r"^[A-Za-z0-9_-]+$")

    def __init__(
        self,
        *,
        connection_repository: GoogleAuthConnectionRepository,
        state_repository: GoogleOAuthStateRepository,
        gateway: GoogleOAuthGateway,
        context_signer: GoogleOAuthContextSignerProtocol,
        token_cipher: TokenCipherProtocol,
        redirect_uri: str,
        scopes: Sequence[str] = GOOGLE_OAUTH_SCOPES,
    ) -> None:
        """Initialize the Google OAuth coordinator.

        Args:
            connection_repository: Persistence boundary for Google OAuth connections.
            state_repository: Persistence boundary for Google OAuth state documents.
            gateway: Google OAuth HTTP gateway boundary.
            context_signer: Signed context token helper.
            token_cipher: Token encryption helper.
            redirect_uri: Absolute callback URI registered for the Google web client.
            scopes: OAuth scopes requested by default.

        Returns:
            None.
        """
        self._connection_repository = connection_repository
        self._state_repository = state_repository
        self._gateway = gateway
        self._context_signer = context_signer
        self._token_cipher = token_cipher
        self._redirect_uri = redirect_uri
        self._scopes = list(scopes)
        self._connection_locks: dict[tuple[str, str, str], asyncio.Lock] = {}

    def issue_start_context(
        self,
        *,
        team_id: str,
        slack_user_id: str,
        redirect_after_connect: str | None = None,
        ttl: timedelta = timedelta(minutes=10),
    ) -> str:
        """Issue a signed context token for the public OAuth start route.

        Args:
            team_id: Slack workspace id that owns the OAuth flow.
            slack_user_id: Slack user id that owns the OAuth flow.
            redirect_after_connect: Optional browser redirect after callback success.
            ttl: Lifetime of the signed context token.

        Returns:
            Signed context token suitable for `/oauth/google/start`.
        """
        normalized_redirect = self._normalize_redirect_after_connect(
            redirect_after_connect
        )
        context = GoogleOAuthStartContext(
            team_id=team_id,
            slack_user_id=slack_user_id,
            redirect_after_connect=normalized_redirect,
            expires_at=utc_now() + ttl,
        )
        return self._context_signer.dumps(context)

    async def begin_authorization(self, *, context_token: str) -> str:
        """Create server-side OAuth state and return the Google auth URL.

        Args:
            context_token: Signed OAuth start context token.

        Returns:
            Google authorization URL for the pending OAuth flow.

        Raises:
            GoogleOAuthFlowError: If the signed context is invalid.
        """
        try:
            context = self._context_signer.loads(context_token)
        except GoogleOAuthContextSignerError as exc:
            raise GoogleOAuthFlowError(
                str(exc),
                code="invalid_context",
                status_code=400,
            ) from exc
        try:
            redirect_after_connect = self._normalize_redirect_after_connect(
                context.redirect_after_connect
            )
        except ValueError as exc:
            raise GoogleOAuthFlowError(
                str(exc),
                code="invalid_context",
                status_code=400,
            ) from exc

        state_id = self._build_state_id()
        expires_at = utc_now() + timedelta(minutes=10)
        state = GoogleOAuthStateDocument(
            state_id=state_id,
            team_id=context.team_id,
            slack_user_id=context.slack_user_id,
            redirect_after_connect=redirect_after_connect,
            requested_scopes=list(self._scopes),
            expires_at=expires_at,
        )
        try:
            await self._create_state(state=state)
        except Exception as exc:
            raise GoogleOAuthFlowError(
                "Failed to create Google OAuth state",
                code="state_storage_error",
                status_code=500,
            ) from exc
        state_token = self._context_signer.dumps_state_token(
            GoogleOAuthStateToken(
                team_id=context.team_id,
                state_id=state_id,
                expires_at=expires_at,
            )
        )
        return self._gateway.build_authorization_url(
            state_id=state_token,
            redirect_uri=self._redirect_uri,
            scopes=list(state.requested_scopes),
        )

    async def handle_callback(
        self,
        *,
        state_id: str | None,
        code: str | None,
        error: str | None,
        error_description: str | None,
    ) -> GoogleOAuthCallbackResult:
        """Consume an OAuth callback and persist the resulting connection.

        Args:
            state_id: OAuth state identifier returned by Google.
            code: OAuth authorization code returned by Google.
            error: Optional OAuth error code returned by Google.
            error_description: Optional OAuth error description returned by Google.

        Returns:
            Completed OAuth callback result containing the stored connection.

        Raises:
            GoogleOAuthFlowError: If the callback is invalid or token exchange fails.
        """
        if not state_id:
            raise GoogleOAuthFlowError(
                "Missing Google OAuth state",
                code="missing_state",
                status_code=400,
            )
        state_reference = self._parse_state_token(state_id)
        if state_reference is None:
            raise GoogleOAuthFlowError(
                "Invalid Google OAuth state",
                code="invalid_state",
                status_code=400,
            )
        try:
            state = await self._consume_state(
                team_id=state_reference.team_id,
                state_id=state_reference.state_id,
            )
        except Exception as exc:
            raise GoogleOAuthFlowError(
                "Failed to consume Google OAuth state",
                code="state_storage_error",
                status_code=500,
            ) from exc
        if state is None:
            raise GoogleOAuthFlowError(
                "Unknown or already consumed Google OAuth state",
                code="invalid_state",
                status_code=400,
            )
        if state.expires_at <= utc_now():
            raise GoogleOAuthFlowError(
                "Expired Google OAuth state",
                code="expired_state",
                status_code=400,
                redirect_after_connect=state.redirect_after_connect,
            )
        if error:
            message = error_description or error
            raise GoogleOAuthFlowError(
                f"Google OAuth was denied: {message}",
                code=error,
                status_code=400,
                redirect_after_connect=state.redirect_after_connect,
            )
        if not code:
            raise GoogleOAuthFlowError(
                "Missing Google OAuth authorization code",
                code="missing_code",
                status_code=400,
                redirect_after_connect=state.redirect_after_connect,
            )

        try:
            tokens = await self._gateway.exchange_code(
                code=code,
                redirect_uri=self._redirect_uri,
            )
            if not tokens.id_token:
                raise GoogleOAuthFlowError(
                    "Google OAuth token response did not include an ID token",
                    code="missing_id_token",
                    status_code=502,
                    redirect_after_connect=state.redirect_after_connect,
                )
            claims = await self._gateway.verify_id_token(id_token=tokens.id_token)
            existing_connection = await self._get_connection(
                team_id=state.team_id,
                slack_user_id=state.slack_user_id,
                google_account_subject=claims.subject,
            )
            now = utc_now()
            refresh_token_encrypted = (
                existing_connection.refresh_token_encrypted
                if existing_connection
                else None
            )
            if tokens.refresh_token:
                refresh_token_encrypted = self._token_cipher.encrypt(
                    tokens.refresh_token
                )
            connection = GoogleAuthConnectionDocument(
                team_id=state.team_id,
                slack_user_id=state.slack_user_id,
                google_account_subject=claims.subject,
                google_account_email=claims.email,
                google_account_email_verified=claims.email_verified,
                granted_scopes=tokens.granted_scopes or list(state.requested_scopes),
                connection_status=GoogleConnectionStatus.ACTIVE,
                access_token_encrypted=self._token_cipher.encrypt(tokens.access_token),
                refresh_token_encrypted=refresh_token_encrypted,
                token_expires_at=tokens.expires_at,
                refresh_token_expires_at=(
                    tokens.refresh_token_expires_at
                    if tokens.refresh_token_expires_at is not None
                    else (
                        existing_connection.refresh_token_expires_at
                        if existing_connection is not None
                        else None
                    )
                ),
                last_refreshed_at=(
                    existing_connection.last_refreshed_at
                    if existing_connection is not None
                    else None
                ),
                last_refresh_error_at=None,
                last_refresh_error_code=None,
                last_successful_access_at=now,
                created_at=existing_connection.created_at
                if existing_connection
                else now,
                updated_at=now,
            )
        except GoogleOAuthFlowError:
            raise
        except GoogleOAuthGatewayError as exc:
            raise GoogleOAuthFlowError(
                str(exc),
                code=exc.error_code or "oauth_callback_failed",
                status_code=502 if exc.retriable else 400,
                redirect_after_connect=state.redirect_after_connect,
            ) from exc
        except TokenCipherError as exc:
            raise GoogleOAuthFlowError(
                str(exc),
                code="oauth_callback_failed",
                status_code=500,
                redirect_after_connect=state.redirect_after_connect,
            ) from exc
        try:
            await self._upsert_connection(connection=connection)
        except Exception as exc:
            raise GoogleOAuthFlowError(
                "Failed to persist Google OAuth callback result",
                code="oauth_storage_error",
                status_code=500,
                redirect_after_connect=state.redirect_after_connect,
            ) from exc
        return GoogleOAuthCallbackResult(
            redirect_after_connect=state.redirect_after_connect,
            connection=connection,
        )

    async def refresh_connection(
        self,
        *,
        team_id: str,
        slack_user_id: str,
        google_account_subject: str,
    ) -> GoogleAuthConnectionDocument:
        """Refresh the access token for an existing Google OAuth connection.

        Args:
            team_id: Slack workspace id owning the connection.
            slack_user_id: Slack user id owning the connection.
            google_account_subject: Stable Google `sub` value for the account.

        Returns:
            Updated connection document after a refresh attempt.

        Raises:
            GoogleOAuthFlowError: If the connection cannot be refreshed.
        """
        async with self._connection_lock(
            team_id=team_id,
            slack_user_id=slack_user_id,
            google_account_subject=google_account_subject,
        ):
            connection = await self._require_connection(
                team_id=team_id,
                slack_user_id=slack_user_id,
                google_account_subject=google_account_subject,
            )
            if connection.refresh_token_encrypted is None:
                raise GoogleOAuthFlowError(
                    "Google OAuth connection does not have a refresh token",
                    code="missing_refresh_token",
                    status_code=400,
                )

            try:
                refresh_token = self._token_cipher.decrypt(
                    connection.refresh_token_encrypted
                )
            except TokenCipherError as exc:
                updated_connection = connection.model_copy(
                    update={
                        "connection_status": GoogleConnectionStatus.ERROR,
                        "last_refresh_error_at": utc_now(),
                        "last_refresh_error_code": "token_decrypt_failed",
                        "updated_at": utc_now(),
                    }
                )
                await self._upsert_connection(connection=updated_connection)
                raise GoogleOAuthFlowError(
                    str(exc),
                    code="token_decrypt_failed",
                    status_code=500,
                ) from exc

            try:
                tokens = await self._gateway.refresh_access_token(
                    refresh_token=refresh_token
                )
            except GoogleOAuthGatewayError as exc:
                now = utc_now()
                status = (
                    GoogleConnectionStatus.EXPIRED
                    if exc.error_code == "invalid_grant"
                    else GoogleConnectionStatus.ACTIVE
                )
                updated_connection = connection.model_copy(
                    update={
                        "connection_status": status,
                        "last_refresh_error_at": now,
                        "last_refresh_error_code": exc.error_code
                        or "refresh_failed",
                        "updated_at": now,
                    }
                )
                await self._upsert_connection(connection=updated_connection)
                raise GoogleOAuthFlowError(
                    str(exc),
                    code=exc.error_code or "refresh_failed",
                    status_code=502 if exc.retriable else 400,
                ) from exc

            latest_connection = await self._require_connection(
                team_id=team_id,
                slack_user_id=slack_user_id,
                google_account_subject=google_account_subject,
            )
            if latest_connection.connection_status == GoogleConnectionStatus.REVOKED:
                return latest_connection

            now = utc_now()
            refresh_token_encrypted = latest_connection.refresh_token_encrypted
            if tokens.refresh_token:
                refresh_token_encrypted = self._token_cipher.encrypt(
                    tokens.refresh_token
                )
            updated_connection = latest_connection.model_copy(
                update={
                    "granted_scopes": tokens.granted_scopes
                    or latest_connection.granted_scopes,
                    "connection_status": GoogleConnectionStatus.ACTIVE,
                    "access_token_encrypted": self._token_cipher.encrypt(
                        tokens.access_token
                    ),
                    "refresh_token_encrypted": refresh_token_encrypted,
                    "token_expires_at": tokens.expires_at,
                    "refresh_token_expires_at": (
                        tokens.refresh_token_expires_at
                        if tokens.refresh_token_expires_at is not None
                        else latest_connection.refresh_token_expires_at
                    ),
                    "last_refreshed_at": now,
                    "last_refresh_error_at": None,
                    "last_refresh_error_code": None,
                    "last_successful_access_at": now,
                    "updated_at": now,
                }
            )
            await self._upsert_connection(connection=updated_connection)
            return updated_connection

    async def revoke_connection(
        self,
        *,
        team_id: str,
        slack_user_id: str,
        google_account_subject: str,
    ) -> GoogleAuthConnectionDocument:
        """Revoke and locally clear a stored Google OAuth connection.

        Args:
            team_id: Slack workspace id owning the connection.
            slack_user_id: Slack user id owning the connection.
            google_account_subject: Stable Google `sub` value for the account.

        Returns:
            Updated connection document after revocation cleanup.

        Raises:
            GoogleOAuthFlowError: If the connection cannot be found.
        """
        async with self._connection_lock(
            team_id=team_id,
            slack_user_id=slack_user_id,
            google_account_subject=google_account_subject,
        ):
            connection = await self._require_connection(
                team_id=team_id,
                slack_user_id=slack_user_id,
                google_account_subject=google_account_subject,
            )

            error_code: str | None = None
            token_to_revoke = self._select_revoke_token(connection)
            if token_to_revoke is not None:
                try:
                    await self._gateway.revoke_token(token=token_to_revoke)
                except GoogleOAuthGatewayError as exc:
                    error_code = exc.error_code or "revoke_failed"

            now = utc_now()
            updated_connection = connection.model_copy(
                update={
                    "connection_status": GoogleConnectionStatus.REVOKED,
                    "access_token_encrypted": None,
                    "refresh_token_encrypted": None,
                    "token_expires_at": None,
                    "refresh_token_expires_at": None,
                    "last_refresh_error_at": now
                    if error_code
                    else connection.last_refresh_error_at,
                    "last_refresh_error_code": error_code,
                    "updated_at": now,
                }
            )
            await self._upsert_connection(connection=updated_connection)
            return updated_connection

    async def _require_connection(
        self,
        *,
        team_id: str,
        slack_user_id: str,
        google_account_subject: str,
    ) -> GoogleAuthConnectionDocument:
        """Load a stored Google OAuth connection or raise a typed error.

        Args:
            team_id: Slack workspace id owning the connection.
            slack_user_id: Slack user id owning the connection.
            google_account_subject: Stable Google `sub` value for the account.

        Returns:
            Stored Google OAuth connection document.

        Raises:
            GoogleOAuthFlowError: If no matching connection exists.
        """
        connection = await self._get_connection(
            team_id=team_id,
            slack_user_id=slack_user_id,
            google_account_subject=google_account_subject,
        )
        if connection is None:
            raise GoogleOAuthFlowError(
                "Google OAuth connection was not found",
                code="connection_not_found",
                status_code=404,
            )
        return connection

    def _select_revoke_token(
        self,
        connection: GoogleAuthConnectionDocument,
    ) -> str | None:
        """Decrypt the best available token to use for revocation.

        Args:
            connection: Stored Google OAuth connection.

        Returns:
            Plaintext refresh token when available, else access token, else `None`.
        """
        for encrypted_token in (
            connection.refresh_token_encrypted,
            connection.access_token_encrypted,
        ):
            if encrypted_token is None:
                continue
            try:
                return self._token_cipher.decrypt(encrypted_token)
            except TokenCipherError:
                continue
        return None

    async def _create_state(
        self,
        *,
        state: GoogleOAuthStateDocument,
    ) -> GoogleOAuthStateDocument:
        """Persist an OAuth state document without blocking the event loop.

        Args:
            state: OAuth state document to store.

        Returns:
            Persisted OAuth state document.
        """
        return await asyncio.to_thread(self._state_repository.create_state, state=state)

    async def _consume_state(
        self,
        *,
        team_id: str,
        state_id: str,
    ) -> GoogleOAuthStateDocument | None:
        """Atomically load and delete an OAuth state without blocking the loop.

        Args:
            team_id: Slack workspace id owning the OAuth flow.
            state_id: Stored OAuth state document id.

        Returns:
            Stored OAuth state document, or `None` when absent.
        """
        return await asyncio.to_thread(
            self._state_repository.consume_state,
            team_id=team_id,
            state_id=state_id,
        )

    async def _delete_state(self, *, team_id: str, state_id: str) -> None:
        """Delete an OAuth state document without blocking the event loop.

        Args:
            team_id: Slack workspace id owning the OAuth flow.
            state_id: Stored OAuth state document id.

        Returns:
            None.
        """
        await asyncio.to_thread(
            self._state_repository.delete_state,
            team_id=team_id,
            state_id=state_id,
        )

    async def _best_effort_delete_state(self, *, team_id: str, state_id: str) -> None:
        """Delete an OAuth state document while suppressing cleanup failures.

        Args:
            team_id: Slack workspace id owning the OAuth flow.
            state_id: Stored OAuth state document id.

        Returns:
            None.
        """
        try:
            await self._delete_state(team_id=team_id, state_id=state_id)
        except Exception:
            return

    async def _get_connection(
        self,
        *,
        team_id: str,
        slack_user_id: str,
        google_account_subject: str,
    ) -> GoogleAuthConnectionDocument | None:
        """Load a connection document without blocking the event loop.

        Args:
            team_id: Slack workspace id owning the connection.
            slack_user_id: Slack user id owning the connection.
            google_account_subject: Stable Google `sub` value for the account.

        Returns:
            Stored connection document, or `None` when absent.
        """
        return await asyncio.to_thread(
            self._connection_repository.get_connection,
            team_id=team_id,
            slack_user_id=slack_user_id,
            google_account_subject=google_account_subject,
        )

    async def _upsert_connection(
        self,
        *,
        connection: GoogleAuthConnectionDocument,
    ) -> GoogleAuthConnectionDocument:
        """Persist a connection document without blocking the event loop.

        Args:
            connection: Connection document to store.

        Returns:
            Persisted connection document.
        """
        return await asyncio.to_thread(
            self._connection_repository.upsert_connection,
            connection=connection,
        )

    def _connection_lock(
        self,
        *,
        team_id: str,
        slack_user_id: str,
        google_account_subject: str,
    ) -> asyncio.Lock:
        """Return the in-process operation lock for one stored connection.

        Args:
            team_id: Slack workspace id owning the connection.
            slack_user_id: Slack user id owning the connection.
            google_account_subject: Stable Google `sub` value for the account.

        Returns:
            Async lock shared by refresh and revoke operations for the connection.
        """
        key = (team_id, slack_user_id, google_account_subject)
        return self._connection_locks.setdefault(key, asyncio.Lock())

    def _build_state_id(self) -> str:
        """Build an opaque document id for a stored OAuth state.

        Returns:
            Random state document id safe for Firestore document naming.
        """
        return secrets.token_urlsafe(24)

    def _parse_state_token(self, state_token: str) -> GoogleOAuthStateToken | None:
        """Decrypt and validate the opaque OAuth callback `state` token.

        Args:
            state_token: Opaque callback `state` query parameter.

        Returns:
            Decoded state token, or `None` when invalid.
        """
        try:
            decoded = self._context_signer.loads_state_token(state_token)
        except GoogleOAuthContextSignerError:
            return None
        if self._STATE_ID_PATTERN.fullmatch(decoded.state_id) is None:
            return None
        return decoded

    def _normalize_redirect_after_connect(self, value: str | None) -> str | None:
        """Validate and normalize a post-connect redirect target.

        Args:
            value: Optional redirect target requested by the caller.

        Returns:
            Normalized relative redirect target, or `None` when no redirect is set.

        Raises:
            ValueError: If the redirect target is not a safe relative path.
        """
        if value is None:
            return None
        parsed = urlsplit(value)
        if parsed.scheme or parsed.netloc or not parsed.path.startswith("/"):
            raise ValueError("redirect_after_connect must be a relative path")
        if parsed.path.startswith("//"):
            raise ValueError("redirect_after_connect must be a relative path")
        return parsed.path + (
            (f"?{parsed.query}" if parsed.query else "")
            + (f"#{parsed.fragment}" if parsed.fragment else "")
        )

    async def aclose(self) -> None:
        """Release resources owned by the coordinator and its gateway.

        Returns:
            None.
        """
        await self._gateway.aclose()
__all__ = [
    "GoogleAuthCoordinator",
    "GoogleOAuthFlowError",
]
