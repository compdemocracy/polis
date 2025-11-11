#!/usr/bin/env python3
"""
Regression testing for Conversation computation pipeline.

Usage:
    # Record golden snapshots
    python regression_test.py record --datasets biodiversity,vw

    # Compare current vs golden
    python regression_test.py compare --datasets biodiversity

    # Update golden after verified changes
    python regression_test.py update --datasets biodiversity --force
"""

import argparse
import sys
from pathlib import Path
from recorder import ConversationRecorder
from comparer import ConversationComparer


def main():
    parser = argparse.ArgumentParser(
        description="Regression testing for Conversation computation pipeline",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  Record golden snapshots for all datasets:
    python regression_test.py record --datasets biodiversity,vw

  Compare current implementation with golden:
    python regression_test.py compare --datasets biodiversity

  Update golden after verified changes:
    python regression_test.py update --datasets biodiversity --force

  Run comparison and show detailed report:
    python regression_test.py compare --datasets biodiversity,vw --verbose
        """
    )

    parser.add_argument(
        "command",
        choices=["record", "compare", "update"],
        help="Command to run: record (create golden), compare (test), or update (overwrite golden)"
    )

    parser.add_argument(
        "--datasets",
        default="biodiversity,vw",
        help="Comma-separated dataset names (default: biodiversity,vw)"
    )

    parser.add_argument(
        "--force",
        action="store_true",
        help="Force overwrite existing golden snapshots"
    )

    parser.add_argument(
        "--verbose",
        action="store_true",
        help="Show detailed comparison reports"
    )

    parser.add_argument(
        "--tolerance-abs",
        type=float,
        default=1e-6,
        help="Absolute tolerance for numeric comparisons (default: 1e-6)"
    )

    parser.add_argument(
        "--tolerance-rel",
        type=float,
        default=0.01,
        help="Relative tolerance for numeric comparisons (default: 0.01)"
    )

    args = parser.parse_args()
    datasets = [d.strip() for d in args.datasets.split(",")]

    # Handle record and update commands
    if args.command in ["record", "update"]:
        recorder = ConversationRecorder()

        for dataset in datasets:
            print(f"\n{'Recording' if args.command == 'record' else 'Updating'} golden snapshot for {dataset}...")

            try:
                golden_path = recorder.record_golden(
                    dataset,
                    force=(args.force or args.command == "update")
                )
                print(f"✅ Success: {golden_path}")
            except Exception as e:
                print(f"❌ Error recording {dataset}: {e}")
                if args.verbose:
                    import traceback
                    traceback.print_exc()
                sys.exit(1)

    # Handle compare command
    elif args.command == "compare":
        comparer = ConversationComparer(
            abs_tolerance=args.tolerance_abs,
            rel_tolerance=args.tolerance_rel
        )

        all_passed = True
        all_results = []

        for dataset in datasets:
            print(f"\n{'=' * 60}")
            print(f"Comparing {dataset} with golden snapshot...")
            print('=' * 60)

            try:
                result = comparer.compare_with_golden(dataset)
                all_results.append((dataset, result))

                # Check for errors
                if "error" in result:
                    print(f"❌ ERROR: {result['error']}")
                    if args.verbose:
                        for key, value in result.items():
                            if key != 'error':
                                print(f"  {key}: {value}")
                    all_passed = False

                # Check comparison results
                elif result["overall_match"]:
                    print(f"✅ {dataset}: All stages match!")
                    if args.verbose:
                        print("\nStage details:")
                        for stage, stage_result in result["stages_compared"].items():
                            status = "✅" if stage_result["match"] else "❌"
                            print(f"  {status} {stage}")
                else:
                    print(f"❌ {dataset}: Regression detected!")
                    print("\nFailed stages:")
                    for stage, stage_result in result["stages_compared"].items():
                        if not stage_result["match"]:
                            print(f"  ❌ {stage}:")
                            print(f"     {stage_result.get('reason', 'unknown reason')}")
                    all_passed = False

            except Exception as e:
                print(f"❌ Error comparing {dataset}: {e}")
                if args.verbose:
                    import traceback
                    traceback.print_exc()
                all_passed = False

        # Print summary
        print(f"\n{'=' * 60}")
        print("SUMMARY")
        print('=' * 60)

        for dataset, result in all_results:
            if "error" in result:
                status = "❌ ERROR"
            elif result.get("overall_match", False):
                status = "✅ PASS"
            else:
                status = "❌ FAIL"
            print(f"{status:12} {dataset}")

        # Generate detailed reports if verbose
        if args.verbose:
            print(f"\n{'=' * 60}")
            print("DETAILED REPORTS")
            print('=' * 60)
            for dataset, result in all_results:
                if result and "stages_compared" in result:
                    print(f"\n{comparer.generate_report(result)}")

        # Exit with appropriate code
        sys.exit(0 if all_passed else 1)


if __name__ == "__main__":
    main()