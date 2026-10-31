import os

from django.contrib.staticfiles.finders import find
from django.contrib.staticfiles.storage import StaticFilesStorage


class VersionedStaticStorage(StaticFilesStorage):
    """Append ?v=<mtime> to every static URL.

    Browsers heuristically cache responses that carry no Cache-Control, and
    runserver's static handler never reaches the middleware chain. A stale
    pinned script against fresh hashes would trip checkCodeIntegrity and wipe
    the user's local keys, so the URL itself has to change with the file.
    """

    def url(self, name):
        url = super().url(name)
        path = find(name)
        if not path or '?' in url:
            return url
        try:
            version = int(os.path.getmtime(path))
        except OSError:
            return url
        return f'{url}?v={version}'
