"""Opaque context tokens for Salesforce OAuth start URLs."""

from __future__ import annotations

import base64
import hashlib
import json

from cryptography.fernet import Fernet, InvalidToken
from pydantic import ValidationError

from agents_party.domain.salesforce_auth import (
    SalesforceOAuthStartContext,
    SalesforceOAuthStateToken,
)
from agents_party.domain.slack_documents import utc_now


class SalesforceOAuthContextSignerError(ValueError):
    """Raised when a signed Salesforce OAuth context token is invalid."""


class SalesforceOAuthContextSigner:
    """Issue and verify opaque Salesforce OAuth start context tokens."""

    def __init__(self, *, secret: str) -> None:
        """Initialize the signer with secret-derived encryption key material.

        Args:
            secret: Secret material used to derive the context encryption key.

        Raises:
            ValueError: If the secret is blank.
        """
        if not secret.strip():
            raise ValueError(
                "Salesforce OAuth context signing secret must not be blank"
            )
        derived_key = base64.urlsafe_b64encode(
            hashlib.sha256(secret.encode("utf-8")).digest()
        )
        self._fernet = Fernet(derived_key)

    def dumps(self, context: SalesforceOAuthStartContext) -> str:
        """Serialize and encrypt a Salesforce OAuth start context.

        Args:
            context: Context payload to serialize and encrypt.

        Returns:
            Opaque token suitable for the public `context` query parameter.
        """
        return self._dump_model(context)

    def dumps_state_token(self, state_token: SalesforceOAuthStateToken) -> str:
        """Serialize and encrypt an OAuth callback state token.

        Args:
            state_token: Callback state token payload to encrypt.

        Returns:
            Opaque token suitable for the OAuth `state` query parameter.
        """
        return self._dump_model(state_token)

    def loads(self, token: str) -> SalesforceOAuthStartContext:
        """Decrypt and deserialize a Salesforce OAuth start context token.

        Args:
            token: Opaque context token from the public `context` query parameter.

        Returns:
            Verified Salesforce OAuth start context payload.

        Raises:
            SalesforceOAuthContextSignerError: If the token is invalid or expired.
        """
        context = self._load_model(token, SalesforceOAuthStartContext)
        if context.expires_at <= utc_now():
            raise SalesforceOAuthContextSignerError(
                "Expired Salesforce OAuth context token"
            )
        return context

    def loads_state_token(self, token: str) -> SalesforceOAuthStateToken:
        """Decrypt and deserialize an OAuth callback state token.

        Args:
            token: Opaque `state` token from the OAuth callback query parameter.

        Returns:
            Verified OAuth callback state token payload.

        Raises:
            SalesforceOAuthContextSignerError: If the token is invalid or expired.
        """
        state_token = self._load_model(token, SalesforceOAuthStateToken)
        if state_token.expires_at <= utc_now():
            raise SalesforceOAuthContextSignerError(
                "Expired Salesforce OAuth state token"
            )
        return state_token

    def _dump_model(
        self,
        model: SalesforceOAuthStartContext | SalesforceOAuthStateToken,
    ) -> str:
        """Serialize and encrypt a supported OAuth model.

        Args:
            model: Supported OAuth model payload to encrypt.

        Returns:
            Opaque encrypted token string.
        """
        payload = json.dumps(
            model.model_dump(mode="json"),
            separators=(",", ":"),
            sort_keys=True,
        ).encode("utf-8")
        return self._fernet.encrypt(payload).decode("utf-8")

    def _load_model[ModelT: SalesforceOAuthStartContext | SalesforceOAuthStateToken](
        self,
        token: str,
        model_type: type[ModelT],
    ) -> ModelT:
        """Decrypt and deserialize a supported OAuth model token.

        Args:
            token: Opaque encrypted token string.
            model_type: Pydantic model type expected after decryption.

        Returns:
            Deserialized model payload.

        Raises:
            SalesforceOAuthContextSignerError: If the token is malformed or invalid.
        """
        try:
            payload = self._fernet.decrypt(token.encode("utf-8"))
        except (InvalidToken, ValueError, TypeError) as exc:
            raise SalesforceOAuthContextSignerError(
                "Malformed Salesforce OAuth context token"
            ) from exc

        try:
            return model_type.model_validate_json(payload)
        except ValidationError as exc:
            raise SalesforceOAuthContextSignerError(
                "Invalid Salesforce OAuth context payload"
            ) from exc


__all__ = ["SalesforceOAuthContextSigner", "SalesforceOAuthContextSignerError"]
