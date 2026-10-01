"""Start Processing without reloading application composition in spawned children."""


def main() -> None:
    """Run the existing worker composition in the supervisor process only.

    Multiprocessing reimports this module when it spawns a native child. Keeping
    application imports inside this function lets the child load only its native
    operation modules. Worker startup, reset and shutdown remain owned by the
    existing composition function.

    Raises:
        ValueError: If worker configuration or source paths are invalid.
    """
    import asyncio
    from contextlib import suppress
    import logging

    from eolab_app.main import run_processing_worker

    logging.basicConfig(level=logging.INFO)
    with suppress(asyncio.CancelledError, KeyboardInterrupt):
        asyncio.run(run_processing_worker())


if __name__ == "__main__":
    main()
