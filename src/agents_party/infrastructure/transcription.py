"""Google Cloud Speech-to-Text transcription helpers."""

from __future__ import annotations

import logging
import shutil
import subprocess
import tempfile
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import Protocol
from uuid import uuid4

from google.cloud import speech_v2, storage
from google.cloud.speech_v2.types import cloud_speech

logger = logging.getLogger(__name__)
_DEFAULT_SPEAKER_COUNT = 8
_DEFAULT_STAGING_PREFIX = "slack-transcriptions"
_DEFAULT_BATCH_TIMEOUT_SECONDS = 900.0
_MAX_EXTRACTED_AUDIO_BYTES = 100 * 1024 * 1024
_VIDEO_FILE_EXTENSIONS = {
    ".avi",
    ".m4v",
    ".mkv",
    ".mov",
    ".mp4",
    ".mpeg",
    ".mpg",
    ".webm",
}
_VIDEO_CONTENT_TYPE_EXTENSIONS = {
    "video/mp4": ".mp4",
    "video/quicktime": ".mov",
    "video/webm": ".webm",
    "video/x-m4v": ".m4v",
    "video/x-matroska": ".mkv",
}


class CloudTranscriptionError(RuntimeError):
    """Raised when Cloud Speech-to-Text cannot return a usable transcript."""


@dataclass(slots=True)
class TranscriptionSegment:
    """Speaker-attributed transcript segment returned by transcription.

    Attributes:
        speaker_label: Stable speaker label such as `Speaker 1`.
        text: Final transcript text attributed to the speaker.
    """

    speaker_label: str
    text: str


@dataclass(slots=True)
class TranscriptionResponse:
    """Normalized transcription result returned by the infrastructure helper.

    Attributes:
        segments: Ordered transcript segments grouped by speaker.
        language_code: Detected language code when the API provides one.
        model: Model identifier used for the transcription request.
    """

    segments: list[TranscriptionSegment]
    language_code: str | None = None
    model: str | None = None


class _BlobLike(Protocol):
    """Protocol describing the subset of a GCS blob used by staging."""

    def upload_from_string(
        self,
        data: bytes,
        *,
        content_type: str | None = None,
    ) -> None:
        """Upload raw object bytes into Cloud Storage."""

    def upload_from_filename(
        self,
        filename: str,
        *,
        content_type: str | None = None,
    ) -> None:
        """Upload a local file into Cloud Storage."""

    def delete(self) -> None:
        """Delete the previously uploaded object from Cloud Storage."""


class _BucketLike(Protocol):
    """Protocol describing the subset of a GCS bucket used by staging."""

    def blob(self, blob_name: str) -> _BlobLike:
        """Return the blob handle for a given object name."""


class CloudStorageStagingService:
    """Thin wrapper around `google-cloud-storage` for temporary file staging."""

    def __init__(
        self,
        *,
        project_id: str,
        bucket_name: str,
        client: storage.Client | None = None,
        prefix: str = _DEFAULT_STAGING_PREFIX,
    ) -> None:
        """Create a staging helper bound to a Google Cloud Storage bucket.

        Args:
            project_id: Google Cloud project id used for client creation.
            bucket_name: Bucket used for transient transcription uploads.
            client: Optional injected Cloud Storage client for tests.
            prefix: Object-name prefix under which staged files are stored.
        """
        self._project_id = project_id
        self._bucket_name = bucket_name
        self._client = client or storage.Client(project=project_id)
        self._prefix = prefix.strip("/") or _DEFAULT_STAGING_PREFIX

    @property
    def bucket_name(self) -> str:
        """Return the configured staging bucket name.

        Returns:
            Cloud Storage bucket name used for staging.
        """
        return self._bucket_name

    def stage_bytes(
        self,
        *,
        data: bytes,
        filename: str | None,
        content_type: str | None = None,
    ) -> tuple[str, str]:
        """Upload raw bytes into the staging bucket.

        Args:
            data: Audio payload to upload.
            filename: Original filename used to derive a readable object suffix.
            content_type: Optional MIME type for the staged object.

        Returns:
            Tuple of `(object_name, gcs_uri)` for the staged upload.

        Raises:
            ValueError: If the payload is empty.
            CloudTranscriptionError: If the upload fails.
        """
        if not data:
            raise ValueError("Transcription audio bytes must not be empty.")

        object_name = self._build_object_name(filename)
        blob = self._client.bucket(self._bucket_name).blob(object_name)
        try:
            blob.upload_from_string(data, content_type=content_type)
        except Exception as exc:  # pragma: no cover - SDK exception surface.
            raise CloudTranscriptionError(
                "Cloud Storage staging upload failed."
            ) from exc
        return object_name, f"gs://{self._bucket_name}/{object_name}"

    def delete_object(self, object_name: str) -> None:
        """Delete a staged object from Cloud Storage.

        Args:
            object_name: Object name previously returned by `stage_bytes`.

        Returns:
            None.
        """
        self._client.bucket(self._bucket_name).blob(object_name).delete()

    def stage_file(
        self,
        *,
        path: Path,
        filename: str | None,
        content_type: str | None = None,
    ) -> tuple[str, str]:
        """Upload a local file into the staging bucket.

        Args:
            path: Local file path to upload.
            filename: Original filename used to derive a readable object suffix.
            content_type: Optional MIME type for the staged object.

        Returns:
            Tuple of `(object_name, gcs_uri)` for the staged upload.

        Raises:
            ValueError: If the file is missing or empty.
            CloudTranscriptionError: If the upload fails.
        """
        if not path.exists() or path.stat().st_size <= 0:
            raise ValueError("Transcription staging file must exist and not be empty.")

        object_name = self._build_object_name(filename)
        blob = self._client.bucket(self._bucket_name).blob(object_name)
        try:
            blob.upload_from_filename(str(path), content_type=content_type)
        except Exception as exc:  # pragma: no cover - SDK exception surface.
            raise CloudTranscriptionError(
                "Cloud Storage staging upload failed."
            ) from exc
        return object_name, f"gs://{self._bucket_name}/{object_name}"

    def _build_object_name(self, filename: str | None) -> str:
        """Return a unique object name for a staged transcription upload.

        Args:
            filename: Optional original file name supplied by Slack.

        Returns:
            Unique object path under the configured prefix.
        """
        raw_name = PurePosixPath(filename or "audio").name
        safe_name = raw_name.replace(" ", "-") or "audio"
        return f"{self._prefix}/{uuid4().hex}-{safe_name}"


class CloudSpeechTranscriptionService:
    """Thin wrapper around `google-cloud-speech` for diarized transcription."""

    def __init__(
        self,
        *,
        project_id: str,
        location: str,
        model: str,
        language_codes: list[str],
        staging_service: CloudStorageStagingService,
        speech_client: speech_v2.SpeechClient | None = None,
        batch_timeout_seconds: float = _DEFAULT_BATCH_TIMEOUT_SECONDS,
    ) -> None:
        """Create a diarized transcription service bound to Google Cloud Speech.

        Args:
            project_id: Google Cloud project id used for Speech requests.
            location: Speech-to-Text region containing the target model.
            model: Speech model id such as `chirp_3`.
            language_codes: Ordered BCP-47 language codes passed to recognition.
            staging_service: Temporary upload helper for batch recognition.
            speech_client: Optional injected Speech client for tests.
            batch_timeout_seconds: Timeout used while waiting for batch completion.
        """
        self._project_id = project_id
        self._location = location
        self._model = model
        self._language_codes = [code.strip() for code in language_codes if code.strip()]
        self._staging_service = staging_service
        self._speech_client = speech_client or speech_v2.SpeechClient()
        self._batch_timeout_seconds = batch_timeout_seconds

    @property
    def recognizer(self) -> str:
        """Return the implicit recognizer resource used by batch requests.

        Returns:
            Fully-qualified recognizer path using the implicit `_` recognizer.
        """
        return f"projects/{self._project_id}/locations/{self._location}/recognizers/_"

    def transcribe_bytes(
        self,
        *,
        data: bytes,
        filename: str | None,
        content_type: str | None = None,
    ) -> TranscriptionResponse:
        """Transcribe a single Slack audio or video payload with speaker diarization.

        Args:
            data: Raw media payload downloaded from Slack.
            filename: Original Slack filename used for staging metadata.
            content_type: Optional MIME type used to detect video inputs.

        Returns:
            Normalized speaker-attributed transcript response.

        Raises:
            ValueError: If required inputs or configuration are blank.
            CloudTranscriptionError: If staging or transcription fails.
        """
        if not data:
            raise ValueError("Transcription audio bytes must not be empty.")
        if not self._language_codes:
            raise ValueError("At least one transcription language code is required.")
        if not self._model.strip():
            raise ValueError("Transcription model must not be blank.")

        if _is_video_payload(filename=filename, content_type=content_type):
            with tempfile.TemporaryDirectory(
                prefix="agents-party-transcription-"
            ) as tmpdir:
                (
                    extracted_audio_path,
                    normalized_filename,
                    normalized_content_type,
                ) = _extract_audio_from_video_bytes(
                    data=data,
                    filename=filename,
                    content_type=content_type,
                    output_dir=Path(tmpdir),
                )
                object_name, gcs_uri = self._staging_service.stage_file(
                    path=extracted_audio_path,
                    filename=normalized_filename,
                    content_type=normalized_content_type,
                )
                return self._transcribe_staged_gcs_uri(
                    object_name=object_name,
                    gcs_uri=gcs_uri,
                )

        object_name, gcs_uri = self._staging_service.stage_bytes(
            data=data,
            filename=filename,
            content_type=content_type,
        )
        return self._transcribe_staged_gcs_uri(
            object_name=object_name,
            gcs_uri=gcs_uri,
        )

    def _transcribe_staged_gcs_uri(
        self,
        *,
        object_name: str,
        gcs_uri: str,
    ) -> TranscriptionResponse:
        """Run batch recognition against a staged Cloud Storage object.

        Args:
            object_name: Cloud Storage object name used for cleanup.
            gcs_uri: Cloud Storage URI passed to Speech-to-Text.

        Returns:
            Normalized speaker-attributed transcript response.

        Raises:
            CloudTranscriptionError: If recognition fails or returns no transcript.
        """
        try:
            response = self._run_batch_recognize(gcs_uri)
        finally:
            try:
                self._staging_service.delete_object(object_name)
            except Exception:  # pragma: no cover - defensive cleanup logging.
                logger.warning(
                    "Failed to delete staged transcription object.",
                    extra={
                        "bucket": self._staging_service.bucket_name,
                        "object": object_name,
                    },
                    exc_info=True,
                )

        file_result = next(iter(response.results.values()), None)
        if file_result is None:
            raise CloudTranscriptionError(
                "Cloud Speech-to-Text returned no file results."
            )
        if file_result.error.code:
            raise CloudTranscriptionError(
                "Cloud Speech-to-Text returned an error for the staged file."
            )
        if not file_result.inline_result.transcript.results:
            raise CloudTranscriptionError(
                "Cloud Speech-to-Text returned an empty transcript."
            )

        transcript_results = list(file_result.inline_result.transcript.results)
        segments = _segments_from_results(transcript_results)
        language_code = next(
            (
                result.language_code
                for result in reversed(transcript_results)
                if result.language_code
            ),
            None,
        )
        return TranscriptionResponse(
            segments=segments,
            language_code=language_code,
            model=self._model,
        )

    def _run_batch_recognize(
        self,
        gcs_uri: str,
    ) -> cloud_speech.BatchRecognizeResponse:
        """Submit a batch transcription job and wait for completion.

        Args:
            gcs_uri: Cloud Storage URI for the staged audio object.

        Returns:
            Completed Speech-to-Text batch response.

        Raises:
            CloudTranscriptionError: If the request fails or the operation errors.
        """
        request = cloud_speech.BatchRecognizeRequest(
            recognizer=self.recognizer,
            config=cloud_speech.RecognitionConfig(
                auto_decoding_config=cloud_speech.AutoDetectDecodingConfig(),
                model=self._model,
                language_codes=self._language_codes,
                features=cloud_speech.RecognitionFeatures(
                    enable_automatic_punctuation=True,
                    diarization_config=cloud_speech.SpeakerDiarizationConfig(
                        min_speaker_count=1,
                        max_speaker_count=_DEFAULT_SPEAKER_COUNT,
                    ),
                ),
            ),
            files=[cloud_speech.BatchRecognizeFileMetadata(uri=gcs_uri)],
            recognition_output_config=cloud_speech.RecognitionOutputConfig(
                inline_response_config=cloud_speech.InlineOutputConfig()
            ),
        )

        try:
            operation = self._speech_client.batch_recognize(request=request)
            return operation.result(timeout=self._batch_timeout_seconds)
        except Exception as exc:  # pragma: no cover - SDK exception surface.
            raise CloudTranscriptionError(
                "Cloud Speech-to-Text batch recognition failed."
            ) from exc


def _is_video_payload(
    *,
    filename: str | None,
    content_type: str | None,
) -> bool:
    """Return whether the supplied media payload should be treated as video.

    Args:
        filename: Original media filename when available.
        content_type: Original media MIME type when available.

    Returns:
        `True` when the payload appears to be a video container.
    """
    if content_type is not None and content_type.startswith("video/"):
        return True
    suffix = PurePosixPath(filename or "").suffix.casefold()
    return suffix in _VIDEO_FILE_EXTENSIONS


def _extract_audio_from_video_bytes(
    *,
    data: bytes,
    filename: str | None,
    content_type: str | None,
    output_dir: Path,
) -> tuple[Path, str, str]:
    """Extract a mono PCM WAV track from a video payload using `ffmpeg`.

    Args:
        data: Raw video container bytes.
        filename: Original video filename when available.
        content_type: Original video MIME type when available.
        output_dir: Existing temporary directory used for ffmpeg input/output files.

    Returns:
        Tuple containing extracted audio path, normalized output filename, and the
        output MIME type.

    Raises:
        CloudTranscriptionError: If `ffmpeg` is unavailable or extraction fails.
    """
    ffmpeg_path = shutil.which("ffmpeg")
    if ffmpeg_path is None:
        raise CloudTranscriptionError(
            "Video transcription requires `ffmpeg` to be installed."
        )

    input_suffix = _video_input_suffix(filename=filename, content_type=content_type)
    output_filename = _wav_output_filename(filename)
    input_path = output_dir / f"source{input_suffix}"
    output_path = output_dir / output_filename
    input_path.write_bytes(data)

    try:
        subprocess.run(
            [
                ffmpeg_path,
                "-y",
                "-nostdin",
                "-loglevel",
                "error",
                "-i",
                str(input_path),
                "-vn",
                "-acodec",
                "pcm_s16le",
                "-ar",
                "16000",
                "-ac",
                "1",
                str(output_path),
            ],
            capture_output=True,
            check=True,
        )
    except (OSError, subprocess.CalledProcessError) as exc:
        raise CloudTranscriptionError("Video audio extraction failed.") from exc

    if not output_path.exists():
        raise CloudTranscriptionError(
            "Video audio extraction returned an empty audio track."
        )
    output_size = output_path.stat().st_size
    if output_size <= 0:
        raise CloudTranscriptionError(
            "Video audio extraction returned an empty audio track."
        )
    if output_size > _MAX_EXTRACTED_AUDIO_BYTES:
        raise CloudTranscriptionError(
            "Video audio extraction exceeded the supported size limit."
        )
    return output_path, output_filename, "audio/wav"


def _video_input_suffix(
    *,
    filename: str | None,
    content_type: str | None,
) -> str:
    """Return a stable temporary file suffix for a video payload.

    Args:
        filename: Original video filename when available.
        content_type: Original video MIME type when available.

    Returns:
        Temporary file suffix used for ffmpeg input.
    """
    suffix = PurePosixPath(filename or "").suffix
    if suffix:
        return suffix
    normalized_type = (content_type or "").strip().casefold()
    return _VIDEO_CONTENT_TYPE_EXTENSIONS.get(normalized_type, ".bin")


def _wav_output_filename(filename: str | None) -> str:
    """Return the normalized WAV filename derived from an original media name.

    Args:
        filename: Original media filename when available.

    Returns:
        WAV filename suitable for staging after extraction.
    """
    stem = PurePosixPath(filename or "video").stem or "video"
    return f"{stem}.wav"


def _segments_from_results(
    results: list[cloud_speech.SpeechRecognitionResult],
) -> list[TranscriptionSegment]:
    """Collapse diarized recognition words into stable speaker segments.

    Args:
        results: Sequential speech recognition results returned by Speech-to-Text.

    Returns:
        Ordered speaker-attributed transcript segments.

    Raises:
        CloudTranscriptionError: If the API returned no usable transcript text.
    """
    diarized_words: list[cloud_speech.WordInfo] = []
    for result in reversed(results):
        if not result.alternatives:
            continue
        top_alternative = result.alternatives[0]
        if top_alternative.words:
            diarized_words = list(top_alternative.words)
            break

    if diarized_words:
        return _segments_from_words(diarized_words)

    fallback_lines = [
        result.alternatives[0].transcript.strip()
        for result in results
        if result.alternatives and result.alternatives[0].transcript.strip()
    ]
    if not fallback_lines:
        raise CloudTranscriptionError(
            "Cloud Speech-to-Text returned no usable transcript text."
        )
    return [
        TranscriptionSegment(speaker_label="Speaker 1", text="\n".join(fallback_lines))
    ]


def _segments_from_words(
    words: list[cloud_speech.WordInfo],
) -> list[TranscriptionSegment]:
    """Group consecutive diarized words under a stable speaker label.

    Args:
        words: Word-level results emitted by the top diarized alternative.

    Returns:
        Ordered speaker-attributed transcript segments.
    """
    segments: list[TranscriptionSegment] = []
    current_label: str | None = None
    current_text = ""

    for word in words:
        token = (word.word or "").strip()
        if not token:
            continue
        speaker_label = _normalize_speaker_label(word.speaker_label)
        if current_label is None:
            current_label = speaker_label
            current_text = token
            continue
        if speaker_label != current_label:
            segments.append(
                TranscriptionSegment(
                    speaker_label=current_label,
                    text=current_text.strip(),
                )
            )
            current_label = speaker_label
            current_text = token
            continue
        current_text = _append_transcript_token(current_text, token)

    if current_label is not None and current_text.strip():
        segments.append(
            TranscriptionSegment(
                speaker_label=current_label,
                text=current_text.strip(),
            )
        )
    return segments


def _normalize_speaker_label(raw_label: str | None) -> str:
    """Normalize provider speaker labels into `Speaker N` form.

    Args:
        raw_label: Provider speaker label returned by Speech-to-Text.

    Returns:
        User-facing speaker label.
    """
    label = (raw_label or "").strip()
    if not label:
        return "Speaker 1"
    if label.casefold().startswith("speaker"):
        return label
    return f"Speaker {label}"


def _append_transcript_token(existing_text: str, token: str) -> str:
    """Append a recognized token with simple punctuation-aware spacing.

    Args:
        existing_text: Current segment transcript.
        token: Next recognized token to append.

    Returns:
        Updated transcript string.
    """
    if not existing_text:
        return token
    if token[:1] in {".", ",", "!", "?", ";", ":", "%", ")", "]", "}", "。", "、"}:
        return existing_text + token
    if token.startswith(("'", "’")):
        return existing_text + token
    if existing_text[-1:] in {"(", "[", "{", "「", "『"}:
        return existing_text + token
    return f"{existing_text} {token}"


__all__ = [
    "CloudSpeechTranscriptionService",
    "CloudStorageStagingService",
    "CloudTranscriptionError",
    "TranscriptionResponse",
    "TranscriptionSegment",
]
