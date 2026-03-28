"""Tests for Google Cloud Speech-to-Text transcription helpers."""

from __future__ import annotations

import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import pytest
from google.cloud.speech_v2.types import cloud_speech

import agents_party.infrastructure.transcription as transcription_module
from agents_party.infrastructure import (
    CloudSpeechTranscriptionService,
    CloudStorageStagingService,
    CloudTranscriptionError,
    TranscriptionSegment,
)


class FakeBlob:
    """Fake Cloud Storage blob used to record upload and delete activity."""

    def __init__(self, name: str, *, fail_upload: Exception | None = None) -> None:
        """Initialize the fake blob state.

        Args:
            name: Object name bound to this blob.
            fail_upload: Optional upload error to raise.
        """
        self.name = name
        self.fail_upload = fail_upload
        self.uploads: list[dict[str, Any]] = []
        self.deleted = False

    def upload_from_string(
        self,
        data: bytes,
        *,
        content_type: str | None = None,
    ) -> None:
        """Record the uploaded payload or raise a configured error.

        Args:
            data: Raw uploaded bytes.
            content_type: Optional MIME type passed by the caller.

        Returns:
            None.
        """
        if self.fail_upload is not None:
            raise self.fail_upload
        self.uploads.append({"data": data, "content_type": content_type})

    def upload_from_filename(
        self,
        filename: str,
        *,
        content_type: str | None = None,
    ) -> None:
        """Record uploaded file contents or raise a configured error.

        Args:
            filename: Local file path uploaded by the caller.
            content_type: Optional MIME type passed by the caller.

        Returns:
            None.
        """
        if self.fail_upload is not None:
            raise self.fail_upload
        self.uploads.append(
            {
                "data": Path(filename).read_bytes(),
                "content_type": content_type,
            }
        )

    def delete(self) -> None:
        """Record that the blob was deleted.

        Returns:
            None.
        """
        self.deleted = True


class FakeBucket:
    """Fake Cloud Storage bucket returning stable fake blobs by name."""

    def __init__(self, *, fail_upload: Exception | None = None) -> None:
        """Initialize the fake bucket state.

        Args:
            fail_upload: Optional upload error to pass to new blobs.
        """
        self.fail_upload = fail_upload
        self.blobs: dict[str, FakeBlob] = {}

    def blob(self, blob_name: str) -> FakeBlob:
        """Return a persistent fake blob for the requested object name.

        Args:
            blob_name: Requested object name.

        Returns:
            Fake blob handle.
        """
        blob = self.blobs.get(blob_name)
        if blob is None:
            blob = FakeBlob(blob_name, fail_upload=self.fail_upload)
            self.blobs[blob_name] = blob
        return blob


class FakeStorageClient:
    """Fake Cloud Storage client returning a single fake bucket."""

    def __init__(self, bucket: FakeBucket) -> None:
        """Initialize the fake storage client.

        Args:
            bucket: Fake bucket returned for all bucket lookups.
        """
        self._bucket = bucket
        self.bucket_calls: list[str] = []

    def bucket(self, bucket_name: str) -> FakeBucket:
        """Return the configured fake bucket.

        Args:
            bucket_name: Requested bucket name.

        Returns:
            Fake bucket used for testing.
        """
        self.bucket_calls.append(bucket_name)
        return self._bucket


@dataclass(slots=True)
class FakeOperation:
    """Fake long-running operation used by the speech client."""

    response: cloud_speech.BatchRecognizeResponse | None = None
    error: Exception | None = None
    timeouts: list[float | None] | None = None

    def result(
        self, timeout: float | None = None
    ) -> cloud_speech.BatchRecognizeResponse:
        """Return the configured response or raise the configured error.

        Args:
            timeout: Timeout passed by the transcription service.

        Returns:
            Batch recognition response.
        """
        if self.timeouts is not None:
            self.timeouts.append(timeout)
        if self.error is not None:
            raise self.error
        assert self.response is not None
        return self.response


class FakeSpeechClient:
    """Fake Speech-to-Text client that records batch recognition requests."""

    def __init__(
        self,
        *,
        response: cloud_speech.BatchRecognizeResponse | None = None,
        error: Exception | None = None,
    ) -> None:
        """Initialize the fake speech client.

        Args:
            response: Optional response returned by the fake operation.
            error: Optional error raised while waiting for the operation.
        """
        self.calls: list[cloud_speech.BatchRecognizeRequest] = []
        self.timeouts: list[float | None] = []
        self._response = response
        self._error = error

    def batch_recognize(
        self, *, request: cloud_speech.BatchRecognizeRequest
    ) -> FakeOperation:
        """Record the batch recognition request.

        Args:
            request: Speech batch request supplied by the service.

        Returns:
            Fake operation that later returns the configured response.
        """
        self.calls.append(request)
        return FakeOperation(
            response=self._response,
            error=self._error,
            timeouts=self.timeouts,
        )


def _build_diarized_response() -> cloud_speech.BatchRecognizeResponse:
    """Return a deterministic diarized Speech-to-Text response for tests.

    Returns:
        Inline batch response with two speaker segments.
    """
    return cloud_speech.BatchRecognizeResponse(
        results={
            "gs://bucket/object.wav": cloud_speech.BatchRecognizeFileResult(
                inline_result=cloud_speech.InlineResult(
                    transcript=cloud_speech.BatchRecognizeResults(
                        results=[
                            cloud_speech.SpeechRecognitionResult(
                                language_code="ja-JP",
                                alternatives=[
                                    cloud_speech.SpeechRecognitionAlternative(
                                        transcript="こんにちは 今日は ありがとうございます",
                                        words=[
                                            cloud_speech.WordInfo(
                                                word="こんにちは",
                                                speaker_label="1",
                                            ),
                                            cloud_speech.WordInfo(
                                                word="今日は",
                                                speaker_label="1",
                                            ),
                                            cloud_speech.WordInfo(
                                                word="ありがとうございます",
                                                speaker_label="2",
                                            ),
                                        ],
                                    )
                                ],
                            )
                        ]
                    )
                )
            )
        }
    )


def test_cloud_storage_staging_service_uploads_bytes_and_returns_gcs_uri() -> None:
    """Verify Cloud Storage staging uploads bytes with a stable object prefix."""
    bucket = FakeBucket()
    client = FakeStorageClient(bucket)
    service = CloudStorageStagingService(
        project_id="demo-project",
        bucket_name="demo-bucket",
        client=client,  # type: ignore[arg-type]
    )

    object_name, gcs_uri = service.stage_bytes(
        data=b"audio-bytes",
        filename="meeting.wav",
        content_type="audio/wav",
    )

    blob = bucket.blobs[object_name]
    assert client.bucket_calls == ["demo-bucket"]
    assert object_name.startswith("slack-transcriptions/")
    assert gcs_uri == f"gs://demo-bucket/{object_name}"
    assert blob.uploads == [{"data": b"audio-bytes", "content_type": "audio/wav"}]


def test_transcribe_bytes_builds_speech_request_and_groups_speakers() -> None:
    """Verify transcription builds the Speech request and normalizes speakers."""
    bucket = FakeBucket()
    storage_client = FakeStorageClient(bucket)
    staging_service = CloudStorageStagingService(
        project_id="demo-project",
        bucket_name="demo-bucket",
        client=storage_client,  # type: ignore[arg-type]
    )
    speech_client = FakeSpeechClient(response=_build_diarized_response())
    service = CloudSpeechTranscriptionService(
        project_id="demo-project",
        location="us",
        model="chirp_3",
        language_codes=["ja-JP"],
        staging_service=staging_service,
        speech_client=speech_client,  # type: ignore[arg-type]
    )

    result = service.transcribe_bytes(
        data=b"audio-bytes",
        filename="meeting.wav",
        content_type="audio/wav",
    )

    request = speech_client.calls[0]
    assert request.recognizer == "projects/demo-project/locations/us/recognizers/_"
    assert request.config.model == "chirp_3"
    assert list(request.config.language_codes) == ["ja-JP"]
    assert request.config.features.enable_automatic_punctuation is True
    assert request.config.features.diarization_config.max_speaker_count == 8
    assert request.files[0].uri.startswith("gs://demo-bucket/slack-transcriptions/")
    assert (
        request.recognition_output_config.inline_response_config
        == cloud_speech.InlineOutputConfig()
    )
    assert speech_client.timeouts == [900.0]
    assert result.language_code == "ja-JP"
    assert result.segments == [
        TranscriptionSegment(speaker_label="Speaker 1", text="こんにちは 今日は"),
        TranscriptionSegment(speaker_label="Speaker 2", text="ありがとうございます"),
    ]


def test_transcribe_bytes_extracts_audio_from_video_before_staging(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Verify video payloads are converted to WAV before staging.

    Args:
        monkeypatch: Pytest monkeypatch fixture used to stub ffmpeg execution.

    Returns:
        None.
    """
    bucket = FakeBucket()
    storage_client = FakeStorageClient(bucket)
    staging_service = CloudStorageStagingService(
        project_id="demo-project",
        bucket_name="demo-bucket",
        client=storage_client,  # type: ignore[arg-type]
    )
    speech_client = FakeSpeechClient(response=_build_diarized_response())

    def fake_run(command: list[str], *, capture_output: bool, check: bool) -> Any:
        """Pretend ffmpeg extracted a WAV file for the supplied video input.

        Args:
            command: Subprocess command emitted by the extractor.
            capture_output: Whether stdio is captured.
            check: Whether subprocess errors should raise.

        Returns:
            Minimal completed-process-like object.
        """
        assert capture_output is True
        assert check is True
        assert command[0] == "/opt/homebrew/bin/ffmpeg"
        assert command[-1].endswith("meeting.wav")
        output_path = command[-1]
        with open(output_path, "wb") as output_file:
            output_file.write(b"extracted-audio")
        return type("Completed", (), {"returncode": 0})()

    monkeypatch.setattr(
        transcription_module.shutil, "which", lambda _: "/opt/homebrew/bin/ffmpeg"
    )
    monkeypatch.setattr(transcription_module.subprocess, "run", fake_run)

    service = CloudSpeechTranscriptionService(
        project_id="demo-project",
        location="us",
        model="chirp_3",
        language_codes=["ja-JP"],
        staging_service=staging_service,
        speech_client=speech_client,  # type: ignore[arg-type]
    )

    service.transcribe_bytes(
        data=b"video-bytes",
        filename="meeting.mp4",
        content_type="video/mp4",
    )

    request = speech_client.calls[0]
    assert request.files[0].uri.endswith(".wav")
    blob = next(iter(bucket.blobs.values()))
    assert blob.uploads == [{"data": b"extracted-audio", "content_type": "audio/wav"}]


def test_transcribe_bytes_raises_when_video_extraction_fails(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Verify video extraction failures surface as transcription errors.

    Args:
        monkeypatch: Pytest monkeypatch fixture used to stub ffmpeg execution.

    Returns:
        None.
    """
    bucket = FakeBucket()
    storage_client = FakeStorageClient(bucket)
    staging_service = CloudStorageStagingService(
        project_id="demo-project",
        bucket_name="demo-bucket",
        client=storage_client,  # type: ignore[arg-type]
    )
    speech_client = FakeSpeechClient(response=_build_diarized_response())

    def fail_run(command: list[str], *, capture_output: bool, check: bool) -> Any:
        """Raise a subprocess failure for the ffmpeg extraction command.

        Args:
            command: Subprocess command emitted by the extractor.
            capture_output: Whether stdio is captured.
            check: Whether subprocess errors should raise.

        Returns:
            Never returns because the function always raises.
        """
        del capture_output, check
        raise subprocess.CalledProcessError(1, command)

    monkeypatch.setattr(
        transcription_module.shutil, "which", lambda _: "/opt/homebrew/bin/ffmpeg"
    )
    monkeypatch.setattr(transcription_module.subprocess, "run", fail_run)

    service = CloudSpeechTranscriptionService(
        project_id="demo-project",
        location="us",
        model="chirp_3",
        language_codes=["ja-JP"],
        staging_service=staging_service,
        speech_client=speech_client,  # type: ignore[arg-type]
    )

    with pytest.raises(CloudTranscriptionError, match="Video audio extraction failed"):
        service.transcribe_bytes(
            data=b"video-bytes",
            filename="meeting.mp4",
            content_type="video/mp4",
        )


def test_transcribe_bytes_rejects_oversized_extracted_audio(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Verify extracted audio larger than the cap fails before staging.

    Args:
        monkeypatch: Pytest monkeypatch fixture used to stub ffmpeg execution.

    Returns:
        None.
    """
    bucket = FakeBucket()
    storage_client = FakeStorageClient(bucket)
    staging_service = CloudStorageStagingService(
        project_id="demo-project",
        bucket_name="demo-bucket",
        client=storage_client,  # type: ignore[arg-type]
    )
    speech_client = FakeSpeechClient(response=_build_diarized_response())

    def fake_run(command: list[str], *, capture_output: bool, check: bool) -> Any:
        """Pretend ffmpeg produced an oversized WAV output file.

        Args:
            command: Subprocess command emitted by the extractor.
            capture_output: Whether stdio is captured.
            check: Whether subprocess errors should raise.

        Returns:
            Minimal completed-process-like object.
        """
        assert capture_output is True
        assert check is True
        Path(command[-1]).write_bytes(b"a" * 9)
        return type("Completed", (), {"returncode": 0})()

    monkeypatch.setattr(
        transcription_module.shutil, "which", lambda _: "/opt/homebrew/bin/ffmpeg"
    )
    monkeypatch.setattr(transcription_module.subprocess, "run", fake_run)
    monkeypatch.setattr(transcription_module, "_MAX_EXTRACTED_AUDIO_BYTES", 8)

    service = CloudSpeechTranscriptionService(
        project_id="demo-project",
        location="us",
        model="chirp_3",
        language_codes=["ja-JP"],
        staging_service=staging_service,
        speech_client=speech_client,  # type: ignore[arg-type]
    )

    with pytest.raises(
        CloudTranscriptionError, match="exceeded the supported size limit"
    ):
        service.transcribe_bytes(
            data=b"video-bytes",
            filename="meeting.mp4",
            content_type="video/mp4",
        )

    assert bucket.blobs == {}


def test_transcribe_bytes_deletes_staged_object_when_batch_recognition_fails() -> None:
    """Verify staged audio is cleaned up when batch recognition fails."""
    bucket = FakeBucket()
    storage_client = FakeStorageClient(bucket)
    staging_service = CloudStorageStagingService(
        project_id="demo-project",
        bucket_name="demo-bucket",
        client=storage_client,  # type: ignore[arg-type]
    )
    speech_client = FakeSpeechClient(error=RuntimeError("boom"))
    service = CloudSpeechTranscriptionService(
        project_id="demo-project",
        location="us",
        model="chirp_3",
        language_codes=["ja-JP"],
        staging_service=staging_service,
        speech_client=speech_client,  # type: ignore[arg-type]
    )

    with pytest.raises(CloudTranscriptionError, match="batch recognition failed"):
        service.transcribe_bytes(
            data=b"audio-bytes",
            filename="meeting.wav",
            content_type="audio/wav",
        )

    assert len(bucket.blobs) == 1
    blob = next(iter(bucket.blobs.values()))
    assert blob.deleted is True
