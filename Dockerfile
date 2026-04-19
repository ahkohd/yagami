FROM node:24-alpine
RUN npm install -g @ahkohd/yagami
EXPOSE 43111
CMD ["yagami", "start", "--foreground"]
