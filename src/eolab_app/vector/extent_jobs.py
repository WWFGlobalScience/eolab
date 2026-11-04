"""Read filtered original-source bounds through the Jobs service."""

from typing import Any

import httpx2

from eolab_jobs.client import JobFailed, JobsClient
from eolab_app.catalog_selection import VectorSelection
from eolab_app.vector.errors import VectorConflictError
from eolab_app.vector.extent_operation import SelectionExtentResult


class ExtentJobs:
    """Submit original-source extent jobs with cancellation and readable errors."""

    def __init__(self, jobs: JobsClient) -> None:
        """Use the application's authenticated Jobs connection.

        Args:
            jobs: Client that submits jobs, waits for results and cancels abandoned work.
        """
        self.jobs = jobs

    async def __call__(
        self, selection: VectorSelection, upload_owner: str | None = None
    ) -> dict[str, Any]:
        """Queue an original-source read and return projected feature envelopes.

        Args:
            selection: Catalog or upload source and filter, with no private path.
            upload_owner: Server-derived browser identity, kept inside Jobs.

        Returns:
            Matching count and WGS84 bounds, including an empty successful result.

        Raises:
            VectorConflictError: For read failures or Jobs overload.
            asyncio.CancelledError: After Jobs cancels and cleans up abandoned work.
        """
        try:
            result = await self.jobs.run(
                {
                    "operation": "vector.selection-extent.v1",
                    "inputs": {
                        "selection": selection.model_dump(mode="json", by_alias=True),
                        "uploadOwner": upload_owner,
                    },
                    "priority": 0,
                    "executionTimeoutSeconds": 15,
                    "queueTimeoutSeconds": 30,
                },
                timeout_seconds=60,
                delete_on_completion=True,
            )
            measured = SelectionExtentResult.model_validate(result.value)
        except JobFailed as error:
            message = {
                "expired": "Vector zoom waited too long in the job queue; try again.",
                "timed_out": "Vector reading exceeded its time budget",
                "cancelled": "Vector zoom was cancelled; try again.",
            }.get(
                error.snapshot.status,
                "Bounds of the filtered features could not be read; try zooming again.",
            )
            raise VectorConflictError(message) from error
        except httpx2.HTTPStatusError as error:
            message = (
                "The application is busy or unavailable; try zooming again shortly."
                if error.response.status_code == 503
                else "Filtered features are unavailable; try zooming again."
            )
            raise VectorConflictError(message) from error
        except (httpx2.HTTPError, ValueError, TimeoutError) as error:
            raise VectorConflictError(
                "Filtered features are unavailable; try zooming again."
            ) from error
        if measured.error is not None:
            raise VectorConflictError(measured.error)
        return measured.extent.model_dump(mode="json")
