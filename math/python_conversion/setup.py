"""
Setup script for polismath package.
"""

from setuptools import setup, find_packages

setup(
    name="polismath",
    version="0.1.0",
    packages=find_packages(),
    install_requires=[
        # Core numerical dependencies
        "numpy>=1.20.0",
        "pandas>=1.3.0",
        "scipy>=1.7.0",
        "scikit-learn>=1.0.0",
        
        # Database
        "sqlalchemy>=1.4.0",
        "psycopg2-binary>=2.9.0",
        
        # Web server
        "fastapi>=0.70.0",
        "uvicorn>=0.15.0",
        "pydantic>=1.8.0",
        
        # Utilities
        "pyyaml>=6.0.0",
        
        # Testing
        "pytest>=6.0.0",
    ],
    entry_points={
        'console_scripts': [
            'polismath=polismath.__main__:main',
        ],
    },
    author="Pol.is Team",
    author_email="team@pol.is",
    description="Mathematical backbone for the Pol.is conversation system",
    keywords="polis, nlp, clustering, opinion analysis",
    python_requires=">=3.8",
)