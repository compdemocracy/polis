"""Utilities; numerical converters do not initialize storage dependencies."""

__all__ = ['DynamoDBStorage', 'DataConverter']


def __getattr__(name):
    if name == 'DataConverter':
        from .converter import DataConverter
        return DataConverter
    if name == 'DynamoDBStorage':
        from .storage import DynamoDBStorage
        return DynamoDBStorage
    raise AttributeError(name)
