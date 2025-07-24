FROM python:3.13-slim-bookworm

ENV DEBIAN_FRONTEND=noninteractive
ENV PYTHONUNBUFFERED=1

WORKDIR /app/

RUN apt-get update && apt-get install -y \
    gdal-bin \
    libgdal-dev

RUN python -m pip install --upgrade pip

COPY requirements.txt .

RUN pip install --no-cache-dir -r requirements.txt

COPY . /app/

RUN python setup.py install

ENTRYPOINT ["iris"]