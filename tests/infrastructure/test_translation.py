from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

import pytest

from agents_party.infrastructure import CloudTranslationError, CloudTranslationService


@dataclass(slots=True)
class FakeTranslation:
    """Fake translated segment returned by the stub Translation client."""

    translated_text: str
    detected_language_code: str | None = None
    model: str | None = None


@dataclass(slots=True)
class FakeTranslateResponse:
    """Fake Translation API response wrapper used by unit tests."""

    translations: list[FakeTranslation] = field(default_factory=list)


class FakeTranslationClient:
    """Stub client for `google-cloud-translate` unit tests."""

    def __init__(
        self,
        *,
        response: FakeTranslateResponse | None = None,
        error: Exception | None = None,
    ) -> None:
        """Initialize the stub client.

        Args:
            response: Response returned by `translate_text`.
            error: Optional exception raised by `translate_text`.
        """
        self.response = response or FakeTranslateResponse()
        self.error = error
        self.calls: list[dict[str, Any]] = []

    def translate_text(self, **kwargs: Any) -> FakeTranslateResponse:
        """Record a Translation API request and return the configured response.

        Args:
            **kwargs: Request keyword arguments passed by the service helper.

        Returns:
            Configured fake Translation API response.

        Raises:
            Exception: Re-raises the configured client error.
        """
        self.calls.append(kwargs)
        if self.error is not None:
            raise self.error
        return self.response


def test_translate_text_passes_cloud_translation_interface_fields() -> None:
    """Verify the helper uses Translation API keyword arguments correctly.

    Returns:
        None.
    """
    client = FakeTranslationClient(
        response=FakeTranslateResponse(
            translations=[
                FakeTranslation(
                    translated_text="こんにちは",
                    detected_language_code="en",
                    model="projects/test/locations/global/models/general/nmt",
                )
            ]
        )
    )
    service = CloudTranslationService(
        project_id="demo-project",
        client=client,  # type: ignore[arg-type]
    )

    result = service.translate_text(
        text="Hello",
        target_language_code="ja",
        mime_type="text/plain",
    )

    assert client.calls == [
        {
            "parent": "projects/demo-project/locations/global",
            "contents": ["Hello"],
            "target_language_code": "ja",
            "mime_type": "text/plain",
        }
    ]
    assert result.translated_text == "こんにちは"
    assert result.detected_language_code == "en"


def test_translate_text_raises_for_blank_target_language_code() -> None:
    """Verify blank target language codes are rejected before the API call.

    Returns:
        None.
    """
    service = CloudTranslationService(
        project_id="demo-project",
        client=FakeTranslationClient(),  # type: ignore[arg-type]
    )

    with pytest.raises(ValueError, match="Target language code must not be blank"):
        service.translate_text(text="Hello", target_language_code=" ")


def test_translate_text_wraps_client_errors() -> None:
    """Verify SDK failures are wrapped in `CloudTranslationError`.

    Returns:
        None.
    """
    service = CloudTranslationService(
        project_id="demo-project",
        client=FakeTranslationClient(error=RuntimeError("boom")),  # type: ignore[arg-type]
    )

    with pytest.raises(CloudTranslationError, match="request failed"):
        service.translate_text(text="Hello", target_language_code="ja")
