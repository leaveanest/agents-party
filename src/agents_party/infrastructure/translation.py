"""Google Cloud Translation API helpers."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from google.cloud import translate


class CloudTranslationError(RuntimeError):
    """Raised when Cloud Translation cannot return a usable translation."""


@dataclass(slots=True)
class TranslationResponse:
    """Normalized translation result returned by the infrastructure helper.

    Attributes:
        translated_text: Final translated text returned by Cloud Translation.
        detected_language_code: Detected source language code when auto-detection ran.
        model: Model identifier reported by Cloud Translation, if any.
    """

    translated_text: str
    detected_language_code: str | None = None
    model: str | None = None


class CloudTranslationService:
    """Thin wrapper around `google-cloud-translate` for text translation."""

    def __init__(
        self,
        *,
        project_id: str,
        location: str = "global",
        client: translate.TranslationServiceClient | None = None,
    ) -> None:
        """Create a translation service bound to a Google Cloud project.

        Args:
            project_id: Google Cloud project id used for Translation API requests.
            location: Translation API location, defaulting to `global`.
            client: Optional injected Translation API client for tests.
        """
        self._project_id = project_id
        self._location = location
        self._client = client or translate.TranslationServiceClient()

    @property
    def parent(self) -> str:
        """Return the resource parent used by Translation API requests.

        Returns:
            Resource path in `projects/{project}/locations/{location}` form.
        """
        return f"projects/{self._project_id}/locations/{self._location}"

    def translate_text(
        self,
        *,
        text: str,
        target_language_code: str,
        source_language_code: str | None = None,
        mime_type: str = "text/plain",
        model: str | None = None,
    ) -> TranslationResponse:
        """Translate a single text payload with Cloud Translation.

        Args:
            text: Source text to translate.
            target_language_code: Target ISO-639 or supported BCP-47 language code.
            source_language_code: Optional source language code when already known.
            mime_type: MIME type of the source text payload.
            model: Optional fully-qualified Translation API model resource name.

        Returns:
            Normalized translation response containing the first translated segment.

        Raises:
            ValueError: If the text or target language code is blank.
            CloudTranslationError: If the API request fails or returns no translations.
        """
        if not text.strip():
            raise ValueError("Translation text must not be blank.")
        if not target_language_code.strip():
            raise ValueError("Target language code must not be blank.")

        request_kwargs: dict[str, Any] = {
            "parent": self.parent,
            "contents": [text],
            "target_language_code": target_language_code,
            "mime_type": mime_type,
        }
        if source_language_code:
            request_kwargs["source_language_code"] = source_language_code
        if model:
            request_kwargs["model"] = model

        try:
            response = self._client.translate_text(**request_kwargs)
        except Exception as exc:  # pragma: no cover - SDK exception surface.
            raise CloudTranslationError(
                "Cloud Translation API request failed."
            ) from exc

        translations = list(response.translations)
        if not translations:
            raise CloudTranslationError(
                "Cloud Translation API returned no translated segments."
            )

        first_translation = translations[0]
        translated_text = (first_translation.translated_text or "").strip()
        if not translated_text:
            raise CloudTranslationError(
                "Cloud Translation API returned an empty translation."
            )

        return TranslationResponse(
            translated_text=translated_text,
            detected_language_code=first_translation.detected_language_code or None,
            model=first_translation.model or None,
        )


__all__ = [
    "CloudTranslationError",
    "CloudTranslationService",
    "TranslationResponse",
]
