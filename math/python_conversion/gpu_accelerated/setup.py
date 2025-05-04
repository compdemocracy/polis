from setuptools import setup, find_packages

setup(
    name="polismath-gpu",
    version="0.1.0",
    description="GPU-accelerated Pol.is math implementation",
    author="Pol.is Team",
    author_email="team@pol.is",
    packages=find_packages(),
    install_requires=[
        "numpy>=1.20.0",
        "pandas>=1.3.0",
        "scipy>=1.7.0",
        "scikit-learn>=1.0.0",
        "matplotlib>=3.5.0",
        "seaborn>=0.11.0",
    ],
    extras_require={
        "cuda": ["cupy-cuda11x>=10.0.0"],
        "torch": ["torch>=1.12.0"],
        "tests": ["pytest>=6.0.0", "pytest-cov>=2.12.0"],
        "dev": ["jupyter>=1.0.0", "black>=21.12b0", "psutil>=5.9.0"],
    },
)