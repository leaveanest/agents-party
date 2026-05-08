"""Salesforce OAuth coordination logic for FastAPI routes and future callers."""

from __future__ import annotations

import asyncio
import re
import secrets
from datetime import timedelta
from typing import Protocol
from urllib.parse import urlsplit

from agents_party.domain.salesforce_auth import (
    SALESFORCE_OAUTH_SCOPES,
    SalesforceConnectionDocument,
    SalesforceConnectionStatus,
    SalesforceOAuthCallbackResult,
    SalesforceOAuthStartContext,
    SalesforceOAuthStateDocument,
    SalesforceOAuthStateToken,
    SalesforceWorkspaceAuthConfigDocument,
    SalesforceWorkspaceAuthConfigStatus,
)
from agents_party.domain.slack_documents import utc_now
from agents_party.infrastructure.salesforce import (
    SalesforceOAuthContextSignerError,
    SalesforceOAuthGatewayError,
    SalesforceTokenCipherError,
)
from agents_party.infrastructure.salesforce.oauth_gateway import (
    build_pkce_code_challenge,
)
from agents_party.repositories.salesforce_auth_config_repository import (
    SalesforceWorkspaceAuthConfigRepository,
)
from agents_party.repositories.salesforce_connection_repository import (
    SalesforceConnectionRepository,
)
from agents_party.repositories.salesforce_oauth_gateway import SalesforceOAuthGateway
from agents_party.repositories.salesforce_oauth_state_repository import (
    SalesforceOAuthStateRepository,
)


class SalesforceOAuthFlowError(RuntimeError):
    """Raised when the Salesforce OAuth flow cannot continue."""

    def __init__(
        self,
        message: str,
        *,
        code: str,
        status_code: int,
        redirect_after_connect: str | None = None,
    ) -> None:
        """Initialize the Salesforce OAuth flow error.

        Args:
            message: Human-readable failure message.
            code: Stable machine-readable error code.
            status_code: HTTP status code that best represents the error.
            redirect_after_connect: Optional redirect target to preserve UX flow.
        """
        super().__init__(message)
        self.code = code
        self.status_code = status_code
        self.redirect_after_connect = redirect_after_connect


class SalesforceOAuthContextSignerProtocol(Protocol):
    """Protocol for issuing and verifying signed OAuth context tokens."""

    def dumps(self, context: SalesforceOAuthStartContext) -> str:
        """Serialize and sign a Salesforce OAuth start context.

        Args:
            context: Context payload to serialize.

        Returns:
            Signed token suitable for the public `context` query parameter.
        """

        ...

    def loads(self, token: str) -> SalesforceOAuthStartContext:
        """Verify and deserialize a signed Salesforce OAuth start context.

        Args:
            token: Signed context token from the public `context` query parameter.

        Returns:
            Verified Salesforce OAuth start context.
        """

        ...

    def dumps_state_token(self, state_token: SalesforceOAuthStateToken) -> str:
        """Serialize and encrypt an OAuth callback state token.

        Args:
            state_token: Callback state token payload to encrypt.

        Returns:
            Opaque token suitable for the OAuth `state` query parameter.
        """

        ...

    def loads_state_token(self, token: str) -> SalesforceOAuthStateToken:
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


class SalesforceAuthCoordinator:
    """Coordinate Salesforce OAuth start, callback, refresh, and revoke flows."""

    _STATE_ID_PATTERN = re.compile(r"^[A-Za-z0-9_-]+$")

    def __init__(
        self,
        *,
        config_repository: SalesforceWorkspaceAuthConfigRepository,
        connection_repository: SalesforceConnectionRepository,
        state_repository: SalesforceOAuthStateRepository,
        gateway: SalesforceOAuthGateway,
        context_signer: SalesforceOAuthContextSignerProtocol,
        token_cipher: TokenCipherProtocol,
    ) -> None:
        """Initialize the Salesforce OAuth coordinator.

        Args:
            config_repository: Persistence boundary for workspace OAuth configs.
            connection_repository: Persistence boundary for Salesforce connections.
            state_repository: Persistence boundary for Salesforce OAuth state.
            gateway: Salesforce OAuth HTTP gateway boundary.
            context_signer: Signed context token helper.
            token_cipher: Token encryption helper.
        """
        self._config_repository = config_repository
        self._connection_repository = connection_repository
        self._state_repository = state_repository
        self._gateway = gateway
        self._context_signer = context_signer
        self._token_cipher = token_cipher
        self._connection_locks: dict[tuple[str, str, str], asyncio.Lock] = {}

    def issue_start_context(
        self,
        *,
        team_id: str,
        slack_user_id: str,
        salesforce_org_id: str,
        redirect_after_connect: str | None = None,
        ttl: timedelta = timedelta(minutes=10),
    ) -> str:
        """Issue a signed context token for the public OAuth start route.

        Args:
            team_id: Slack workspace id that owns the OAuth flow.
            slack_user_id: Slack user id that owns the OAuth flow.
            salesforce_org_id: Salesforce org id to connect.
            redirect_after_connect: Optional browser redirect after callback success.
            ttl: Lifetime of the signed context token.

        Returns:
            Signed context token suitable for `/oauth/salesforce/start`.
        """
        normalized_redirect = self._normalize_redirect_after_connect(
            redirect_after_connect
        )
        context = SalesforceOAuthStartContext(
            team_id=team_id,
            slack_user_id=slack_user_id,
            salesforce_org_id=salesforce_org_id,
            redirect_after_connect=normalized_redirect,
            expires_at=utc_now() + ttl,
        )
        return self._context_signer.dumps(context)

    async def begin_authorization(self, *, context_token: str) -> str:
        """Create server-side OAuth state and return the Salesforce auth URL.

        Args:
            context_token: Signed OAuth start context token.

        Returns:
            Salesforce authorization URL for the pending OAuth flow.

        Raises:
            SalesforceOAuthFlowError: If the signed context or workspace
                configuration is invalid.
        """
        try:
            context = self._context_signer.loads(context_token)
        except SalesforceOAuthContextSignerError as exc:
            raise SalesforceOAuthFlowError(
                str(exc),
                code="invalid_context",
                status_code=400,
            ) from exc
        try:
            redirect_after_connect = self._normalize_redirect_after_connect(
                context.redirect_after_connect
            )
        except ValueError as exc:
            raise SalesforceOAuthFlowError(
                str(exc),
                code="invalid_context",
                status_code=400,
            ) from exc
        config = await self._require_active_config(
            team_id=context.team_id,
            salesforce_org_id=context.salesforce_org_id,
        )

        state_id = self._build_state_id()
        code_verifier = self._build_pkce_code_verifier()
        expires_at = utc_now() + timedelta(minutes=10)
        state = SalesforceOAuthStateDocument(
            state_id=state_id,
            team_id=context.team_id,
            slack_user_id=context.slack_user_id,
            salesforce_org_id=context.salesforce_org_id,
            pkce_code_verifier_encrypted=self._token_cipher.encrypt(code_verifier),
            redirect_after_connect=redirect_after_connect,
            requested_scopes=list(config.default_scopes or SALESFORCE_OAUTH_SCOPES),
            expires_at=expires_at,
        )
        try:
            await self._create_state(state=state)
        except Exception as exc:
            raise SalesforceOAuthFlowError(
                "Failed to create Salesforce OAuth state",
                code="state_storage_error",
                status_code=500,
            ) from exc
        state_token = self._context_signer.dumps_state_token(
            SalesforceOAuthStateToken(
                team_id=context.team_id,
                state_id=state_id,
                expires_at=expires_at,
            )
        )
        return self._gateway.build_authorization_url(
            config=config,
            state_id=state_token,
            code_challenge=build_pkce_code_challenge(code_verifier),
            scopes=list(state.requested_scopes),
        )

    async def handle_callback(
        self,
        *,
        state_id: str | None,
        code: str | None,
        error: str | None,
        error_description: str | None,
    ) -> SalesforceOAuthCallbackResult:
        """Consume an OAuth callback and persist the resulting connection.

        Args:
            state_id: OAuth state identifier returned by Salesforce.
            code: OAuth authorization code returned by Salesforce.
            error: Optional OAuth error code returned by Salesforce.
            error_description: Optional OAuth error description returned by Salesforce.

        Returns:
            Completed OAuth callback result containing the stored connection.

        Raises:
            SalesforceOAuthFlowError: If the callback is invalid or token exchange
                fails.
        """
        state = await self._load_callback_state(state_id=state_id)
        if state.expires_at <= utc_now():
            raise SalesforceOAuthFlowError(
                "Expired Salesforce OAuth state",
                code="expired_state",
                status_code=400,
                redirect_after_connect=state.redirect_after_connect,
            )
        if error:
            message = error_description or error
            raise SalesforceOAuthFlowError(
                f"Salesforce OAuth was denied: {message}",
                code=error,
                status_code=400,
                redirect_after_connect=state.redirect_after_connect,
            )
        if not code:
            raise SalesforceOAuthFlowError(
                "Missing Salesforce OAuth authorization code",
                code="missing_code",
                status_code=400,
                redirect_after_connect=state.redirect_after_connect,
            )
        config = await self._require_active_config(
            team_id=state.team_id,
            salesforce_org_id=state.salesforce_org_id,
            redirect_after_connect=state.redirect_after_connect,
        )

        try:
            code_verifier = self._token_cipher.decrypt(
                state.pkce_code_verifier_encrypted
            )
            tokens = await self._gateway.exchange_code(
                config=config,
                code=code,
                code_verifier=code_verifier,
            )
            if not tokens.identity_url:
                raise SalesforceOAuthFlowError(
                    "Salesforce OAuth token response did not include an identity URL",
                    code="missing_identity_url",
                    status_code=502,
                    redirect_after_connect=state.redirect_after_connect,
                )
            identity = await self._gateway.lookup_identity(
                identity_url=tokens.identity_url,
                access_token=tokens.access_token,
            )
            if identity.organization_id != state.salesforce_org_id:
                raise SalesforceOAuthFlowError(
                    "Salesforce OAuth identity did not match the requested org",
                    code="org_mismatch",
                    status_code=400,
                    redirect_after_connect=state.redirect_after_connect,
                )
            existing_connection = await self._get_connection(
                team_id=state.team_id,
                slack_user_id=state.slack_user_id,
                salesforce_org_id=state.salesforce_org_id,
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
            connection = SalesforceConnectionDocument(
                team_id=state.team_id,
                slack_user_id=state.slack_user_id,
                salesforce_org_id=state.salesforce_org_id,
                salesforce_user_id=identity.user_id,
                salesforce_username=identity.username,
                salesforce_user_email=identity.email,
                salesforce_identity_url=identity.identity_url or tokens.identity_url,
                salesforce_instance_url=tokens.instance_url,
                granted_scopes=tokens.granted_scopes or list(state.requested_scopes),
                connection_status=SalesforceConnectionStatus.ACTIVE,
                access_token_encrypted=self._token_cipher.encrypt(tokens.access_token),
                refresh_token_encrypted=refresh_token_encrypted,
                token_expires_at=tokens.expires_at,
                last_refreshed_at=(
                    existing_connection.last_refreshed_at
                    if existing_connection is not None
                    else None
                ),
                last_refresh_error_at=None,
                last_refresh_error_code=None,
                last_successful_access_at=now,
                created_at=existing_connection.created_at
                if existing_connection is not None
                else now,
                updated_at=now,
            )
        except SalesforceOAuthFlowError:
            raise
        except SalesforceOAuthGatewayError as exc:
            raise SalesforceOAuthFlowError(
                str(exc),
                code=exc.error_code or "oauth_callback_failed",
                status_code=502 if exc.retriable else 400,
                redirect_after_connect=state.redirect_after_connect,
            ) from exc
        except SalesforceTokenCipherError as exc:
            raise SalesforceOAuthFlowError(
                str(exc),
                code="oauth_callback_failed",
                status_code=500,
                redirect_after_connect=state.redirect_after_connect,
            ) from exc
        try:
            await self._upsert_connection(connection=connection)
        except Exception as exc:
            raise SalesforceOAuthFlowError(
                "Failed to persist Salesforce OAuth callback result",
                code="oauth_storage_error",
                status_code=500,
                redirect_after_connect=state.redirect_after_connect,
            ) from exc
        return SalesforceOAuthCallbackResult(
            redirect_after_connect=state.redirect_after_connect,
            connection=connection,
        )

    async def refresh_connection(
        self,
        *,
        team_id: str,
        slack_user_id: str,
        salesforce_org_id: str,
    ) -> SalesforceConnectionDocument:
        """Refresh the access token for an existing Salesforce OAuth connection.

        Args:
            team_id: Slack workspace id owning the connection.
            slack_user_id: Slack user id owning the connection.
            salesforce_org_id: Salesforce org id for the connection.

        Returns:
            Updated connection document after a refresh attempt.

        Raises:
            SalesforceOAuthFlowError: If the connection cannot be refreshed.
        """
        async with self._connection_lock(
            team_id=team_id,
            slack_user_id=slack_user_id,
            salesforce_org_id=salesforce_org_id,
        ):
            connection = await self._require_connection(
                team_id=team_id,
                slack_user_id=slack_user_id,
                salesforce_org_id=salesforce_org_id,
            )
            config = await self._require_active_config(
                team_id=team_id,
                salesforce_org_id=salesforce_org_id,
            )
            if connection.refresh_token_encrypted is None:
                raise SalesforceOAuthFlowError(
                    "Salesforce OAuth connection does not have a refresh token",
                    code="missing_refresh_token",
                    status_code=400,
                )
            try:
                refresh_token = self._token_cipher.decrypt(
                    connection.refresh_token_encrypted
                )
            except SalesforceTokenCipherError as exc:
                updated_connection = connection.model_copy(
                    update={
                        "connection_status": SalesforceConnectionStatus.ERROR,
                        "last_refresh_error_at": utc_now(),
                        "last_refresh_error_code": "token_decrypt_failed",
                        "updated_at": utc_now(),
                    }
                )
                await self._upsert_connection(connection=updated_connection)
                raise SalesforceOAuthFlowError(
                    str(exc),
                    code="token_decrypt_failed",
                    status_code=500,
                ) from exc

            try:
                tokens = await self._gateway.refresh_access_token(
                    config=config,
                    refresh_token=refresh_token,
                )
            except SalesforceOAuthGatewayError as exc:
                updated_connection = self._with_refresh_error(connection, exc)
                await self._upsert_connection(connection=updated_connection)
                raise SalesforceOAuthFlowError(
                    str(exc),
                    code=exc.error_code or "refresh_failed",
                    status_code=502 if exc.retriable else 400,
                ) from exc

            latest_connection = await self._require_connection(
                team_id=team_id,
                slack_user_id=slack_user_id,
                salesforce_org_id=salesforce_org_id,
            )
            if (
                latest_connection.connection_status
                == SalesforceConnectionStatus.REVOKED
            ):
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
                    "connection_status": SalesforceConnectionStatus.ACTIVE,
                    "access_token_encrypted": self._token_cipher.encrypt(
                        tokens.access_token
                    ),
                    "refresh_token_encrypted": refresh_token_encrypted,
                    "token_expires_at": tokens.expires_at,
                    "salesforce_instance_url": tokens.instance_url
                    or latest_connection.salesforce_instance_url,
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
        salesforce_org_id: str,
    ) -> SalesforceConnectionDocument:
        """Revoke and locally clear a stored Salesforce OAuth connection.

        Args:
            team_id: Slack workspace id owning the connection.
            slack_user_id: Slack user id owning the connection.
            salesforce_org_id: Salesforce org id for the connection.

        Returns:
            Updated connection document after revocation cleanup.

        Raises:
            SalesforceOAuthFlowError: If the connection or config cannot be found.
        """
        async with self._connection_lock(
            team_id=team_id,
            slack_user_id=slack_user_id,
            salesforce_org_id=salesforce_org_id,
        ):
            connection = await self._require_connection(
                team_id=team_id,
                slack_user_id=slack_user_id,
                salesforce_org_id=salesforce_org_id,
            )
            config = await self._require_active_config(
                team_id=team_id,
                salesforce_org_id=salesforce_org_id,
            )

            error_code: str | None = None
            token_to_revoke = self._select_revoke_token(connection)
            if token_to_revoke is not None:
                try:
                    await self._gateway.revoke_token(
                        config=config,
                        token=token_to_revoke,
                    )
                except SalesforceOAuthGatewayError as exc:
                    error_code = exc.error_code or "revoke_failed"

            now = utc_now()
            updated_connection = connection.model_copy(
                update={
                    "connection_status": SalesforceConnectionStatus.REVOKED,
                    "access_token_encrypted": None,
                    "refresh_token_encrypted": None,
                    "token_expires_at": None,
                    "last_refresh_error_at": now
                    if error_code
                    else connection.last_refresh_error_at,
                    "last_refresh_error_code": error_code,
                    "updated_at": now,
                }
            )
            await self._upsert_connection(connection=updated_connection)
            return updated_connection

    async def revoke_connection_from_context(
        self,
        *,
        context_token: str,
    ) -> SalesforceConnectionDocument:
        """Revoke a Salesforce OAuth connection from a signed context token.

        Args:
            context_token: Signed context identifying the Slack user and org.

        Returns:
            Updated connection document after revocation cleanup.

        Raises:
            SalesforceOAuthFlowError: If the context is invalid or revocation fails.
        """
        try:
            context = self._context_signer.loads(context_token)
        except SalesforceOAuthContextSignerError as exc:
            raise SalesforceOAuthFlowError(
                str(exc),
                code="invalid_context",
                status_code=400,
            ) from exc
        return await self.revoke_connection(
            team_id=context.team_id,
            slack_user_id=context.slack_user_id,
            salesforce_org_id=context.salesforce_org_id,
        )

    async def _load_callback_state(
        self,
        *,
        state_id: str | None,
    ) -> SalesforceOAuthStateDocument:
        """Decode, consume, and validate the callback state reference.

        Args:
            state_id: Opaque public state token returned by Salesforce.

        Returns:
            Stored Salesforce OAuth state document.

        Raises:
            SalesforceOAuthFlowError: If the state token is missing or invalid.
        """
        if not state_id:
            raise SalesforceOAuthFlowError(
                "Missing Salesforce OAuth state",
                code="missing_state",
                status_code=400,
            )
        state_reference = self._parse_state_token(state_id)
        if state_reference is None:
            raise SalesforceOAuthFlowError(
                "Invalid Salesforce OAuth state",
                code="invalid_state",
                status_code=400,
            )
        try:
            state = await self._consume_state(
                team_id=state_reference.team_id,
                state_id=state_reference.state_id,
            )
        except Exception as exc:
            raise SalesforceOAuthFlowError(
                "Failed to consume Salesforce OAuth state",
                code="state_storage_error",
                status_code=500,
            ) from exc
        if state is None:
            raise SalesforceOAuthFlowError(
                "Unknown or already consumed Salesforce OAuth state",
                code="invalid_state",
                status_code=400,
            )
        return state

    async def _require_active_config(
        self,
        *,
        team_id: str,
        salesforce_org_id: str,
        redirect_after_connect: str | None = None,
    ) -> SalesforceWorkspaceAuthConfigDocument:
        """Load an active workspace auth configuration or raise a typed error.

        Args:
            team_id: Slack workspace id owning the configuration.
            salesforce_org_id: Salesforce org id for the configuration.
            redirect_after_connect: Optional redirect target to attach to errors.

        Returns:
            Active workspace OAuth configuration.

        Raises:
            SalesforceOAuthFlowError: If no active configuration exists.
        """
        config = await asyncio.to_thread(
            self._config_repository.get_config,
            team_id=team_id,
            salesforce_org_id=salesforce_org_id,
        )
        if config is None:
            raise SalesforceOAuthFlowError(
                "Salesforce OAuth configuration was not found",
                code="config_not_found",
                status_code=404,
                redirect_after_connect=redirect_after_connect,
            )
        if config.status != SalesforceWorkspaceAuthConfigStatus.ACTIVE:
            raise SalesforceOAuthFlowError(
                "Salesforce OAuth configuration is disabled",
                code="config_disabled",
                status_code=400,
                redirect_after_connect=redirect_after_connect,
            )
        return config

    async def _require_connection(
        self,
        *,
        team_id: str,
        slack_user_id: str,
        salesforce_org_id: str,
    ) -> SalesforceConnectionDocument:
        """Load a stored Salesforce OAuth connection or raise a typed error.

        Args:
            team_id: Slack workspace id owning the connection.
            slack_user_id: Slack user id owning the connection.
            salesforce_org_id: Salesforce org id for the connection.

        Returns:
            Stored Salesforce OAuth connection document.

        Raises:
            SalesforceOAuthFlowError: If no matching connection exists.
        """
        connection = await self._get_connection(
            team_id=team_id,
            slack_user_id=slack_user_id,
            salesforce_org_id=salesforce_org_id,
        )
        if connection is None:
            raise SalesforceOAuthFlowError(
                "Salesforce OAuth connection was not found",
                code="connection_not_found",
                status_code=404,
            )
        return connection

    def _with_refresh_error(
        self,
        connection: SalesforceConnectionDocument,
        exc: SalesforceOAuthGatewayError,
    ) -> SalesforceConnectionDocument:
        """Return a connection updated with refresh failure details.

        Args:
            connection: Existing Salesforce connection document.
            exc: Gateway error raised during refresh.

        Returns:
            Updated connection document with status and error metadata.
        """
        if exc.error_code == "invalid_grant":
            status = SalesforceConnectionStatus.EXPIRED
        elif exc.retriable:
            status = SalesforceConnectionStatus.ACTIVE
        else:
            status = SalesforceConnectionStatus.ERROR
        now = utc_now()
        return connection.model_copy(
            update={
                "connection_status": status,
                "last_refresh_error_at": now,
                "last_refresh_error_code": exc.error_code or "refresh_failed",
                "updated_at": now,
            }
        )

    def _select_revoke_token(
        self,
        connection: SalesforceConnectionDocument,
    ) -> str | None:
        """Decrypt the best available token to use for revocation.

        Args:
            connection: Stored Salesforce OAuth connection.

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
            except SalesforceTokenCipherError:
                continue
        return None

    async def _create_state(
        self,
        *,
        state: SalesforceOAuthStateDocument,
    ) -> SalesforceOAuthStateDocument:
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
    ) -> SalesforceOAuthStateDocument | None:
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

    async def _get_connection(
        self,
        *,
        team_id: str,
        slack_user_id: str,
        salesforce_org_id: str,
    ) -> SalesforceConnectionDocument | None:
        """Load a connection document without blocking the event loop.

        Args:
            team_id: Slack workspace id owning the connection.
            slack_user_id: Slack user id owning the connection.
            salesforce_org_id: Salesforce org id for the connection.

        Returns:
            Stored connection document, or `None` when absent.
        """
        return await asyncio.to_thread(
            self._connection_repository.get_connection,
            team_id=team_id,
            slack_user_id=slack_user_id,
            salesforce_org_id=salesforce_org_id,
        )

    async def _upsert_connection(
        self,
        *,
        connection: SalesforceConnectionDocument,
    ) -> SalesforceConnectionDocument:
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
        salesforce_org_id: str,
    ) -> asyncio.Lock:
        """Return the in-process operation lock for one stored connection.

        Args:
            team_id: Slack workspace id owning the connection.
            slack_user_id: Slack user id owning the connection.
            salesforce_org_id: Salesforce org id for the connection.

        Returns:
            Async lock shared by refresh and revoke operations for the connection.
        """
        key = (team_id, slack_user_id, salesforce_org_id)
        return self._connection_locks.setdefault(key, asyncio.Lock())

    def _build_state_id(self) -> str:
        """Build an opaque document id for a stored OAuth state.

        Returns:
            Random state document id safe for persisted OAuth state keys.
        """
        return secrets.token_urlsafe(24)

    def _build_pkce_code_verifier(self) -> str:
        """Build a high-entropy PKCE verifier for Salesforce OAuth.

        Returns:
            URL-safe PKCE verifier string.
        """
        return secrets.token_urlsafe(64)

    def _parse_state_token(self, state_token: str) -> SalesforceOAuthStateToken | None:
        """Decrypt and validate the opaque OAuth callback `state` token.

        Args:
            state_token: Opaque callback `state` query parameter.

        Returns:
            Decoded state token, or `None` when invalid.
        """
        try:
            decoded = self._context_signer.loads_state_token(state_token)
        except SalesforceOAuthContextSignerError:
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
    "SalesforceAuthCoordinator",
    "SalesforceOAuthFlowError",
]
