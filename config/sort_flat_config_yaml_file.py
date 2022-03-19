#!/usr/bin/env python3
import subprocess
import sys
import yaml

from collections import defaultdict, OrderedDict

def parse_preserving_duplicates(src):
    # We deliberately define a fresh class inside the function,
    # because add_constructor is a class method and we don't want to
    # mutate pyyaml classes.
    class PreserveDuplicatesLoader(yaml.loader.Loader):
        pass

    def map_constructor(loader, node, deep=False):
        """Walk the mapping, recording any duplicate keys.

        """
        mapping = defaultdict(list)
        for key_node, value_node in node.value:
            key = loader.construct_object(key_node, deep=deep)
            value = loader.construct_object(value_node, deep=deep)

            mapping[key].append(value)

        return mapping

    PreserveDuplicatesLoader.add_constructor(yaml.resolver.BaseResolver.DEFAULT_MAPPING_TAG, map_constructor)
    return yaml.load(src, PreserveDuplicatesLoader)

if len(sys.argv) != 2:
    print("ERROR: this script takes a single argument, a yaml file name.")
    sys.exit()

file = sys.argv[1]



with open(file) as src:
    data = yaml.safe_load(src)
sorted_data = {}
for key in sorted(data.keys()):
    sorted_data[key] = data[key]
print(yaml.dump(sorted_data))

with open(file) as src:
    data = parse_preserving_duplicates(src)
print(f"finding duplicate keys in {file}")
count = 0
for key in data.keys():
    if len(data[key]) > 1: 
        count += 1
        print(f"key: {key}")
        print(f"value:\n{data[key]}")
print(f"number of keys: {len(data)}")
if  count == 0:
    print("no duplicates found")
else:
    print("WARNING: only one duplicate was output below")


