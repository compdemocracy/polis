#!/usr/bin/env python

import xml.etree.ElementTree as ET
import sys

def main(path='/app/coverage.xml'):
    """
    Parses a coverage.xml file and prints a Markdown table to stdout.
    """
    try:
        tree = ET.parse(path)
        root = tree.getroot()

        lines = [
            "| File | Stmts | Miss | Cover |",
            "|------|-------|------|-------|"
        ]
        
        total_statements = 0
        total_missed = 0
        
        packages = root.find('packages')
        if packages is None:
            print("Could not find 'packages' tag in coverage.xml", file=sys.stderr)
            sys.exit(1)

        all_files = []
        for package in packages.findall('package'):
            classes = package.find('classes')
            if classes is None:
                continue
            
            for cls in classes.findall('class'):
                filename = cls.get('filename') # This is the path
                line_rate = float(cls.get('line-rate', '0'))
                
                lines_node = cls.find('lines')
                if lines_node is None:
                    continue
                    
                lines_valid = 0
                lines_covered = 0
                
                for line in lines_node.findall('line'):
                    lines_valid += 1
                    if int(line.get('hits', '0')) > 0:
                        lines_covered += 1
                
                if lines_valid == 0:
                    continue # Skip files with no executable statements

                lines_missed = lines_valid - lines_covered
                total_statements += lines_valid
                total_missed += lines_missed
                
                coverage_percent = line_rate * 100
                all_files.append((filename, lines_valid, lines_missed, coverage_percent))

        # Sort files alphabetically
        all_files.sort(key=lambda x: x[0])
        
        for f in all_files:
            lines.append(f"| {f[0]} | {f[1]} | {f[2]} | {f[3]:.0f}% |")

        if total_statements > 0:
            total_coverage = ((total_statements - total_missed) / total_statements) * 100
            lines.append(f"| **Total** | **{total_statements}** | **{total_missed}** | **{total_coverage:.0f}%** |")
        else:
            lines.append("| **Total** | **0** | **0** | **N/A** |")

        # Print to stdout
        print('\n'.join(lines))
            
    except Exception as e:
        print(f"Error parsing coverage.xml: {e}", file=sys.stderr)
        print(f"Error generating coverage report: {e}")
        sys.exit(1)

if __name__ == "__main__":
    main(*sys.argv[1:2])