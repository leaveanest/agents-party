"""FastAPI routes for the Google OAuth flow."""

from __future__ import annotations

from collections.abc import Callable
from html import escape
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

from fastapi import APIRouter, HTTPException
from fastapi.responses import HTMLResponse, RedirectResponse, Response

from agents_party.google_auth.service import GoogleAuthCoordinator, GoogleOAuthFlowError

type GoogleAuthCoordinatorProvider = Callable[[], GoogleAuthCoordinator | None]


def create_google_auth_router(
    coordinator: GoogleAuthCoordinator | None = None,
    *,
    coordinator_provider: GoogleAuthCoordinatorProvider | None = None,
) -> APIRouter:
    """Create the FastAPI router for Google OAuth endpoints.

    Args:
        coordinator: Google OAuth coordinator instance used for every request.
        coordinator_provider: Optional provider that returns the current
            coordinator instance for each request.

    Returns:
        Configured FastAPI router for Google OAuth routes.
    """
    router = APIRouter()

    def resolve_coordinator() -> GoogleAuthCoordinator | None:
        """Return the current coordinator instance for the active request.

        Returns:
            Current Google OAuth coordinator, or `None` when disabled.
        """
        if coordinator_provider is not None:
            return coordinator_provider()
        return coordinator

    @router.get("/oauth/google/start")
    async def google_oauth_start(context: str) -> RedirectResponse:
        """Redirect a signed start context to the Google authorization URL.

        Args:
            context: Signed start context token.

        Returns:
            Redirect response to Google's authorization screen.

        Raises:
            HTTPException: If Google OAuth is disabled or the context is invalid.
        """
        active_coordinator = resolve_coordinator()
        if active_coordinator is None:
            raise HTTPException(
                status_code=503,
                detail="Google OAuth is not configured.",
            )
        try:
            authorization_url = await active_coordinator.begin_authorization(
                context_token=context
            )
        except GoogleOAuthFlowError as exc:
            raise HTTPException(status_code=exc.status_code, detail=str(exc)) from exc
        return RedirectResponse(authorization_url, status_code=303)

    @router.get("/oauth/google/callback")
    async def google_oauth_callback(
        state: str | None = None,
        code: str | None = None,
        error: str | None = None,
        error_description: str | None = None,
    ) -> Response:
        """Handle the Google OAuth callback and finish the connection flow.

        Args:
            state: OAuth state identifier returned by Google.
            code: OAuth authorization code returned by Google.
            error: Optional OAuth error code returned by Google.
            error_description: Optional OAuth error description returned by Google.

        Returns:
            Redirect response when a post-connect URL is available, else a minimal
            HTML success or failure page.
        """
        active_coordinator = resolve_coordinator()
        if active_coordinator is None:
            return HTMLResponse(
                _render_result_page(
                    title="Google OAuth unavailable",
                    message="Google OAuth is not configured.",
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
        except GoogleOAuthFlowError as exc:
            if exc.redirect_after_connect:
                return RedirectResponse(
                    _append_query_params(
                        exc.redirect_after_connect,
                        {
                            "google_oauth_status": "error",
                            "google_oauth_error": exc.code,
                        },
                    ),
                    status_code=303,
                )
            return HTMLResponse(
                _render_result_page(
                    title="Google OAuth failed",
                    message=str(exc),
                ),
                status_code=exc.status_code,
            )

        if result.redirect_after_connect:
            return RedirectResponse(
                _append_query_params(
                    result.redirect_after_connect,
                    {"google_oauth_status": "success"},
                ),
                status_code=303,
            )
        return HTMLResponse(
            _render_result_page(
                title="Google account connected",
                message="The Google OAuth flow completed successfully.",
            ),
            status_code=200,
        )

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


__all__ = ["create_google_auth_router"]
