# ---
# jupyter:
#   jupytext:
#     text_representation:
#       extension: .py
#       format_name: light
#       format_version: '1.5'
#       jupytext_version: 1.13.6
#   kernelspec:
#     display_name: Python 3
#     language: python
#     name: python3
# ---

# +
import yaml

import subprocess
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


# +
file = "schema.yaml"
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
    
print("\nFor comparison with the next file:")
keys = [
    'webserver_pass',
    'admin_emails',
    'admin_uids']
for key in keys:
    print(f"key: {key}")
    print(f"    value: {data[key][0]['default'][0]}")
print()
with open(file) as src:
    data = yaml.safe_load(src)

file = "env_all_to_be_deleted.yaml"
with open(file) as src:
    data = parse_preserving_duplicates(src)
print(f"finding duplicate keys in {file}")
for key in data.keys():
    if len(data[key]) > 1: 
        value_set = set()
        for key_dict in data[key]:
            try:
                value_set.add(key_dict['default'][0])
            except TypeError:
                print(f"key: {key}")
                print("    unhashable value: {key_dict['default'][0]}")
        if len(value_set) > 1:
            print(f"key: {key}")
            print(f"    set of values: {value_set}")
print(f"number of keys: {len(data)}")

file = "schema.yaml"
sorted_file = "schema_sorted.yaml"
with open(file) as src:
    data = yaml.safe_load(src)
sorted_data = {}
for key in sorted(data.keys()):
    sorted_data[key] = data[key]
with open(sorted_file, "w") as dest:
    yaml.dump(sorted_data, dest)

print()
polis_path = "/Users/crkrenn/code/polis_dir/polis"  
for key in list(sorted(data.keys())):
    result = subprocess.run(
        ["grep", "-R", 
         "-e", data[key]['env']+':', 
         "-e", data[key]['env']+'=', 
         polis_path],
        capture_output=True)
    print(f"schema key: {key}")
    if not result.returncode:
        print(f"    schema value: {data[key]['default']}")
        result_stdout = result.stdout.decode("utf-8")
        result_stdout_list = result_stdout.split('\n')
        for result_stdout in result_stdout_list:
            try:
                result_stdout = result_stdout.split(':')[1]
            except IndexError:
                pass
            print( "    grep result:" + result_stdout)


# -

data['webserver_pass']


