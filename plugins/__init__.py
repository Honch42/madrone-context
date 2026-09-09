from .base import ContextPlugin
from .screenpipe_plugin import ScreenpipePlugin
from .google_workspace_plugin import GoogleWorkspacePlugin

def get_active_plugins():
    return [ScreenpipePlugin(), GoogleWorkspacePlugin()]
