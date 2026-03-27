#!/bin/bash
source $(conda info --base)/etc/profile.d/conda.sh
conda activate mrandarin
python python/mrandarin_server.py