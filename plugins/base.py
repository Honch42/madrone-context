from abc import ABC, abstractmethod

class ContextPlugin(ABC):
    @property
    @abstractmethod
    def name(self) -> str:
        pass

    @abstractmethod
    def fetch_rearward_context(self, since_timestamp: str) -> str:
        """Fetch historical context since the given timestamp."""
        pass
        
    @abstractmethod
    def fetch_forward_context(self) -> str:
        """Fetch upcoming/forward-looking context (e.g. calendar, drafts)."""
        pass
