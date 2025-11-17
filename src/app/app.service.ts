import { Injectable } from '@nestjs/common';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

function loadHomepageTemplate(): string {
  const candidatePaths = [
    join(__dirname, '..', 'templates', 'homepage.html'),
    join(process.cwd(), 'src', 'templates', 'homepage.html'),
  ];

  for (const filePath of candidatePaths) {
    try {
      return readFileSync(filePath, 'utf-8');
    } catch {
      // continue to next path
    }
  }

  return '<!DOCTYPE html><html><body><h1>Jio20 Session Platform</h1></body></html>';
}

@Injectable()
export class AppService {
  getHello(): string {
    return loadHomepageTemplate();
  }
}
