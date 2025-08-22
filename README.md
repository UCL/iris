# IRIS - Intelligently Reinforced Image Segmentation<sup>1</sup>
<sup>1</sup>Yes, it is a <a href="https://en.wikipedia.org/wiki/Backronym">backronym</a>.

<img src="preview/segmentation.png" />

Tool for manual image segmentation of satellite imagery (or images in general). It was designed to accelerate the creation of machine learning training datasets for Earth Observation. This application is a flask app which can be run locally. Special highlights:
* Support by AI (gradient boosted decision tree) when doing image segmentation
* Multiple and configurable views for multispectral imagery
* Simple setup with pip and one configuration file
* Platform independent app (runs on Linux, Windows and Mac OS)
* Multi-user support: work in a team on your dataset and merge the results

## Installation

Clone the repository, navigate to the directory, and install the package and its dependencies. We recommend doing this inside an environment such as conda, with python 3.8 or 3.9.

```
git clone git@github.com:ESA-PhiLab/iris.git
cd iris
python setup.py install
```

If you are altering the IRIS source code then you may find it easier to install like below, to avoid having to reinstall it every time a change is made
```
pip install -e ./
```


## Usage

Once installed, you can run the demo version of IRIS

```
iris demo
```

Having run the demo, you can then create a personalised config file, based on _demo/cloud-segmentation.json_. With your own config file, you can then instantiate your own custom project. <a href="https://github.com/ESA-PhiLab/iris/blob/master/docs/config.md">Here is a guide</a> on how to write your own config file.

```
iris label <your-config-file>
```

It is recommended to use a keyboard and mouse with scrollwheel for IRIS. Currently, control via trackpad is limited and awkward.


## Deploying with Docker Compose

This section provides step-by-step instructions for deploying IRIS using Docker Compose on your own machine, or on a public web server.

### Prerequisites

1. **Install Docker**: Follow the official Docker installation instructions for your operating system:
   - [Docker Desktop for Windows/Mac](https://docs.docker.com/desktop/)
   - [Docker Engine for Linux](https://docs.docker.com/engine/install/)

2. **Clone the repository**:
   ```bash
   git clone https://github.com/UCL/iris.git && cd iris
   ```

3. **Set up your project directory**:
   Create a `project` directory in the iris repository root and add your configuration files:
   ```bash
   mkdir project && cd project
   ```
   
   You'll need to add:
   - `config.json`: Your project configuration file (see [Configuration Guide](docs/config.md) for details)
   - `images/`: Directory containing your image data
   
   Example project structure:
   ```
   project/
   ├── config.json
   └── images/
       ├── image1/
       │   ├── s1.tif
       │   ├── s2.tif
       │   ├── thumbnail.png
       │   └── metadata.json
       ├── image2/
       │   ├── s1.tif
       │   ├── s2.tif
       │   ├── thumbnail.png
       │   └── metadata.json
       └── ...
   ```

4. **Build and run the containers**:
   ```bash
   # Build the Docker images
   docker-compose build
   
   # Start the services
   docker-compose up -d
   ```

   This will start:
   - **IRIS service** on port 5000
   - **Nginx reverse proxy** on port 80

### Accessing IRIS

Once the containers are running, if running locally, you can access IRIS through your web browser:
- http://localhost
Or if running on a remote server, you can access IRIS through your web browser:
- http://\<your-server-ip\>

### Stopping the Services

To stop the services:
```bash
docker-compose down
```

### Troubleshooting

- **Port conflicts**: If ports 5000 or 80 are already in use, modify the port mappings in `docker-compose.yml`
- **Permission issues**: Ensure Docker has proper permissions to access your project directory
- **Build errors**: Make sure Docker and Docker Compose are properly installed and up to date