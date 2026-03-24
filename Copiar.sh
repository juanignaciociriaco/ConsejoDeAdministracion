#!/bin/bash
ssh acceso@192.168.99.167 'rm -rf ~/ConsejoDeAdministracion'
ssh acceso@192.168.99.167 'mkdir -p ~/ConsejoDeAdministracion'
scp -r * acceso@192.168.99.167:~/ConsejoDeAdministracion
