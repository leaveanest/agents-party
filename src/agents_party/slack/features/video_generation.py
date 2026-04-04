"""Slack video-generation interactions."""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any

from slack_bolt.context.ack.async_ack import AsyncAck
from slack_sdk.web.async_client import AsyncWebClient

from agents_party.agents.video_generation import (
    VideoGenerationInvocation,
    run_video_generation,
)

VIDEO_GENERATION_ACTION_ID = "video_generation:start"
VIDEO_GENERATION_VIEW_CALLBACK_ID = "video_generation:submit"
_PROMPT_BLOCK_ID = "video_generation_prompt"
_PROMPT_ACTION_ID = "video_generation_prompt_value"


def _build_video_generation_view() -> dict[str, Any]:
    """Build the modal payload used to collect a video-generation prompt.

    Returns:
        Slack view payload for the prompt-entry modal.
    """
    return {
        "type": "modal",
        "callback_id": VIDEO_GENERATION_VIEW_CALLBACK_ID,
        "title": {
            "type": "plain_text",
            "text": "Generate video",
        },
        "submit": {
            "type": "plain_text",
            "text": "Generate",
        },
        "close": {
            "type": "plain_text",
            "text": "Cancel",
        },
        "blocks": [
            {
                "type": "input",
                "block_id": _PROMPT_BLOCK_ID,
                "label": {
                    "type": "plain_text",
                    "text": "Prompt",
                },
                "element": {
                    "type": "plain_text_input",
                    "action_id": _PROMPT_ACTION_ID,
                    "multiline": True,
                    "placeholder": {
                        "type": "plain_text",
                        "text": "Describe the short video you want to generate.",
                    },
                },
            }
        ],
    }


def _read_submission_prompt(body: Mapping[str, Any]) -> str:
    """Extract and validate the video-generation prompt from a Slack modal payload.

    Args:
        body: Slack view submission payload containing the modal state.

    Returns:
        Trimmed prompt entered by the user.

    Raises:
        ValueError: If the modal payload does not contain a non-blank prompt.
    """
    view = body.get("view", {})
    view_state = view.get("state", {})
    values = view_state.get("values", {})
    prompt_state = values.get(_PROMPT_BLOCK_ID, {})
    prompt_payload = prompt_state.get(_PROMPT_ACTION_ID, {})
    prompt = str(prompt_payload.get("value", "")).strip()
    if not prompt:
        raise ValueError("Enter a video prompt.")
    return prompt


def _filename_for_media_type(media_type: str) -> str:
    """Return a stable Slack upload filename for the generated video.

    Args:
        media_type: MIME type reported by the video-generation runtime.

    Returns:
        Filename with an extension matching the MIME type when recognized.
    """
    if media_type == "video/quicktime":
        return "generated-video.mov"
    return "generated-video.mp4"


def _build_generation_comment(prompt: str) -> str:
    """Build the Slack comment attached to an uploaded generated video.

    Args:
        prompt: Prompt used for video generation.

    Returns:
        Slack-ready comment summarizing the completed generation request.
    """
    return f"Generated video for prompt:\n{prompt}"


async def _open_user_messages_channel(client: AsyncWebClient, user_id: str) -> str:
    """Open the Slack DM channel used to deliver generated videos.

    Args:
        client: Slack client used to open a direct message conversation.
        user_id: Slack user id that should receive the generated video.

    Returns:
        Slack conversation id for the user's messages surface.

    Raises:
        ValueError: If Slack does not return a usable channel id.
    """
    response = await client.conversations_open(users=user_id)
    channel = response.get("channel", {})
    channel_id = str(channel.get("id", "")).strip()
    if not channel_id:
        raise ValueError("Slack did not return a direct-message channel id.")
    return channel_id


def _build_video_generation_invocation(
    body: Mapping[str, Any],
    prompt: str,
    *,
    user_id: str,
) -> VideoGenerationInvocation:
    """Build the typed agent invocation for a Slack video-generation request.

    Args:
        body: Slack view submission payload containing workspace metadata.
        prompt: Normalized prompt submitted by the Slack user.
        user_id: Slack user id that submitted the prompt.

    Returns:
        Typed video-generation invocation for the specialist runtime.
    """
    team = body.get("team", {})
    team_id = str(team.get("id", "")).strip() or None
    return VideoGenerationInvocation(
        prompt=prompt,
        user_id=user_id,
        team_id=team_id,
    )


async def handle_video_generation_action(
    ack: AsyncAck,
    body: Mapping[str, Any],
    client: AsyncWebClient,
) -> None:
    """Open the video-generation modal from the registered Slack action.

    Args:
        ack: Slack acknowledgement callback for the button action.
        body: Slack action payload containing the trigger id.
        client: Slack client used to open the modal.

    Returns:
        None.
    """
    await ack()
    trigger_id = str(body.get("trigger_id", "")).strip()
    if not trigger_id:
        return

    await client.views_open(
        trigger_id=trigger_id,
        view=_build_video_generation_view(),
    )


async def handle_video_generation_submission(
    ack: AsyncAck,
    body: Mapping[str, Any],
    client: AsyncWebClient,
) -> None:
    """Generate a video from a submitted modal prompt and upload it to Slack.

    Args:
        ack: Slack acknowledgement callback for the view submission.
        body: Slack view submission payload containing the prompt and user id.
        client: Slack client used to post messages and upload the generated video.

    Returns:
        None.
    """
    try:
        prompt = _read_submission_prompt(body)
    except ValueError:
        await ack(
            response_action="errors",
            errors={_PROMPT_BLOCK_ID: "Enter a video prompt."},
        )
        return

    await ack()

    user = body.get("user", {})
    user_id = str(user.get("id", "")).strip()
    if not user_id:
        return

    try:
        delivery_channel_id = await _open_user_messages_channel(client, user_id)
    except ValueError:
        return

    try:
        generated_video = await run_video_generation(
            _build_video_generation_invocation(
                body,
                prompt,
                user_id=user_id,
            )
        )
    except ValueError as exc:
        await client.chat_postMessage(
            channel=delivery_channel_id,
            text=f"Video generation is not configured: {exc}",
        )
        return
    except Exception:
        await client.chat_postMessage(
            channel=delivery_channel_id,
            text=("Video generation failed. Verify Vertex AI access and try again."),
        )
        return

    await client.files_upload_v2(
        channel=delivery_channel_id,
        file=generated_video.data,
        filename=_filename_for_media_type(generated_video.media_type),
        title="Generated video",
        initial_comment=_build_generation_comment(prompt),
    )


__all__ = [
    "VIDEO_GENERATION_ACTION_ID",
    "VIDEO_GENERATION_VIEW_CALLBACK_ID",
    "handle_video_generation_action",
    "handle_video_generation_submission",
]
