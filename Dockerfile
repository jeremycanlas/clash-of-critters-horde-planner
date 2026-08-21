# Reproducible environment for the data pipeline under tools/.
#
# The site itself is plain HTML/CSS/JS with no build step and does not need this
# image. What needs it is the roster regen: scrape-wiki.mjs pulls the roster
# from the wiki, then the Python scripts (Pillow/scipy/numpy) normalize sprites
# and cut backgrounds. Those have real system-level dependencies, so pinning
# them in a container keeps a rebuild identical on any machine and in CI, rather
# than "works on the box that happens to have the right Pillow".
#
# Build:  docker build -t horde-tools .
# Run:    docker run --rm -v "$PWD:/app" horde-tools node tools/scrape-wiki.mjs
#         docker run --rm -v "$PWD:/app" horde-tools python3 tools/normalize_images.py

FROM node:20-slim

# Python 3 plus the imaging/maths stack the sprite scripts import (PIL, numpy,
# scipy). --no-install-recommends keeps the layer lean; the pip wheels are
# manylinux, so nothing compiles here.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 python3-pip \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Only the Python deps need installing; the Node tools use built-ins only.
# --break-system-packages is needed because Debian marks the base Python as
# externally managed (PEP 668), and this is a single-purpose image.
COPY tools/requirements.txt tools/requirements.txt
RUN pip3 install --no-cache-dir --break-system-packages -r tools/requirements.txt

# The source is bind-mounted at run time (see the run examples above), so the
# image stays a thin toolbox rather than a snapshot of the roster data.
CMD ["node", "--version"]
