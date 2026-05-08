"""Application-key token encryption helpers for Salesforce OAuth secrets."""

from __future__ import annotations

from cryptography.fernet import Fernet, InvalidToken


class SalesforceTokenCipherError(ValueError):
    """Raised when Salesforce token encryption or decryption fails."""


class FernetSalesforceTokenCipher:
    """Encrypt and decrypt Salesforce OAuth tokens with Fernet."""

    def __init__(self, *, key: str) -> None:
        """Initialize the token cipher with a base64-encoded Fernet key.

        Args:
            key: Base64-encoded Fernet key used for encryption and decryption.

        Raises:
            SalesforceTokenCipherError: If the provided key is not valid Fernet key
                material.
        """
        try:
            self._fernet = Fernet(key.encode("utf-8"))
        except (ValueError, TypeError) as exc:
            raise SalesforceTokenCipherError(
                "Invalid Salesforce token encryption key"
            ) from exc

    def encrypt(self, value: str) -> str:
        """Encrypt a plaintext token string.

        Args:
            value: Plaintext token to encrypt.

        Returns:
            Encrypted token string.

        Raises:
            SalesforceTokenCipherError: If the token value is blank.
        """
        if not value:
            raise SalesforceTokenCipherError("Cannot encrypt a blank token")
        return self._fernet.encrypt(value.encode("utf-8")).decode("utf-8")

    def decrypt(self, value: str) -> str:
        """Decrypt an encrypted token string.

        Args:
            value: Encrypted token produced by this cipher.

        Returns:
            Decrypted plaintext token string.

        Raises:
            SalesforceTokenCipherError: If the token value is blank or invalid.
        """
        if not value:
            raise SalesforceTokenCipherError("Cannot decrypt a blank token")
        try:
            return self._fernet.decrypt(value.encode("utf-8")).decode("utf-8")
        except (InvalidToken, ValueError, TypeError) as exc:
            raise SalesforceTokenCipherError(
                "Failed to decrypt Salesforce OAuth token"
            ) from exc


__all__ = ["FernetSalesforceTokenCipher", "SalesforceTokenCipherError"]
