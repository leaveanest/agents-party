"""FastAPI routes for the Salesforce OAuth flow."""

from __future__ import annotations

from collections.abc import Callable
from html import escape
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

from fastapi import APIRouter, HTTPException
from fastapi.responses import HTMLResponse, RedirectResponse, Response
from pydantic import BaseModel, ConfigDict

from agents_party.salesforce_auth.service import (
    SalesforceAuthCoordinator,
    SalesforceOAuthFlowError,
)

type SalesforceAuthCoordinatorProvider = Callable[[], SalesforceAuthCoordinator | None]


class SalesforceDisconnectRequest(BaseModel):
    """Request body for disconnecting a Salesforce OAuth connection."""

    model_config = ConfigDict(extra="forbid")

    context: str


def create_salesforce_auth_router(
    coordinator: SalesforceAuthCoordinator | None = None,
    *,
    coordinator_provider: SalesforceAuthCoordinatorProvider | None = None,
) -> APIRouter:
    """Create the FastAPI router for Salesforce OAuth endpoints.

    Args:
        coordinator: Salesforce OAuth coordinator instance used for every request.
        coordinator_provider: Optional provider returning the current coordinator.

    Returns:
        Configured FastAPI router for Salesforce OAuth routes.
    """
    router = APIRouter()

    def resolve_coordinator() -> SalesforceAuthCoordinator | None:
        """Return the current coordinator instance for the active request.

        Returns:
            Current Salesforce OAuth coordinator, or `None` when disabled.
        """
        if coordinator_provider is not None:
            return coordinator_provider()
        return coordinator

    @router.get("/oauth/salesforce/start")
    async def salesforce_oauth_start(context: str) -> RedirectResponse:
        """Redirect a signed start context to the Salesforce authorization URL.

        Args:
            context: Signed start context token.

        Returns:
            Redirect response to Salesforce's authorization screen.

        Raises:
            HTTPException: If Salesforce OAuth is disabled or the context is invalid.
        """
        active_coordinator = resolve_coordinator()
        if active_coordinator is None:
            raise HTTPException(
                status_code=503,
                detail="Salesforce OAuth is not configured.",
            )
        try:
            authorization_url = await active_coordinator.begin_authorization(
                context_token=context
            )
        except SalesforceOAuthFlowError as exc:
            raise HTTPException(status_code=exc.status_code, detail=str(exc)) from exc
        return RedirectResponse(authorization_url, status_code=303)

    @router.get("/oauth/salesforce/callback")
    async def salesforce_oauth_callback(
        state: str | None = None,
        code: str | None = None,
        error: str | None = None,
        error_description: str | None = None,
    ) -> Response:
        """Handle the Salesforce OAuth callback and finish the connection flow.

        Args:
            state: OAuth state identifier returned by Salesforce.
            code: OAuth authorization code returned by Salesforce.
            error: Optional OAuth error code returned by Salesforce.
            error_description: Optional OAuth error description returned by Salesforce.

        Returns:
            Redirect response when a post-connect URL is available, else a minimal
            HTML success or failure page.
        """
        active_coordinator = resolve_coordinator()
        if active_coordinator is None:
            return HTMLResponse(
                _render_result_page(
                    title="Salesforce OAuth unavailable",
                    message="Salesforce OAuth is not configured.",
                ),
                status_code=503,
            )
        try:
            result = await active_coordinator.handle_callback(
                state_id=state,
                code=code,
                error=error,
                error_description=error_description,
            )
        except SalesforceOAuthFlowError as exc:
            if exc.redirect_after_connect:
                return RedirectResponse(
                    _append_query_params(
                        exc.redirect_after_connect,
                        {
                            "salesforce_oauth_status": "error",
                            "salesforce_oauth_error": exc.code,
                        },
                    ),
                    status_code=303,
                )
            return HTMLResponse(
                _render_result_page(
                    title="Salesforce OAuth failed",
                    message=str(exc),
                ),
                status_code=exc.status_code,
            )

        if result.redirect_after_connect:
            return RedirectResponse(
                _append_query_params(
                    result.redirect_after_connect,
                    {"salesforce_oauth_status": "success"},
                ),
                status_code=303,
            )
        return HTMLResponse(
            _render_result_page(
                title="Salesforce account connected",
                message="The Salesforce OAuth flow completed successfully.",
            ),
            status_code=200,
        )

    @router.post("/oauth/salesforce/disconnect")
    async def salesforce_oauth_disconnect(
        request: SalesforceDisconnectRequest,
    ) -> dict[str, str]:
        """Revoke and locally disconnect a Salesforce OAuth connection.

        Args:
            request: Disconnect request identifying the Slack user and org.

        Returns:
            Status payload for the disconnected connection.

        Raises:
            HTTPException: If Salesforce OAuth is disabled or revocation cannot run.
        """
        active_coordinator = resolve_coordinator()
        if active_coordinator is None:
            raise HTTPException(
                status_code=503,
                detail="Salesforce OAuth is not configured.",
            )
        try:
            connection = await active_coordinator.revoke_connection_from_context(
                context_token=request.context,
            )
        except SalesforceOAuthFlowError as exc:
            raise HTTPException(status_code=exc.status_code, detail=str(exc)) from exc
        return {
            "status": connection.connection_status,
            "team_id": connection.team_id,
            "slack_user_id": connection.slack_user_id,
            "salesforce_org_id": connection.salesforce_org_id,
        }

    return router


def _append_query_params(url: str, params: dict[str, str]) -> str:
    """Append query parameters to a redirect URL without dropping existing ones.

    Args:
        url: Existing redirect target.
        params: Query parameters to append.

    Returns:
        Redirect target with merged query parameters.
    """
    split_url = urlsplit(url)
    query_params = dict(parse_qsl(split_url.query, keep_blank_values=True))
    query_params.update(params)
    return urlunsplit(
        (
            split_url.scheme,
            split_url.netloc,
            split_url.path,
            urlencode(query_params),
            split_url.fragment,
        )
    )


def _render_result_page(*, title: str, message: str) -> str:
    """Render a minimal HTML result page for the OAuth browser flow.

    Args:
        title: Short page title to display.
        message: Human-readable message to display.

    Returns:
        Minimal HTML page string.
    """
    escaped_title = escape(title, quote=True)
    escaped_message = escape(message, quote=True)
    return (
        "<!doctype html>"
        "<html><head><meta charset='utf-8'>"
        f"<title>{escaped_title}</title>"
        "</head><body>"
        f"<h1>{escaped_title}</h1>"
        f"<p>{escaped_message}</p>"
        "</body></html>"
    )


__all__ = ["SalesforceDisconnectRequest", "create_salesforce_auth_router"]
